"""Making a named condition true, rather than checking whether it happens to be.

docs/TEST-DATA-ENGINE.md § 3 calls predicates "the interesting case", and the direction of travel
is what makes them interesting: `overdue` is not a field a tester can set, it is a condition the
application derives, and solving it means working backwards from the condition to values that
produce it. Sampling `dueAt` from the observed range and hoping it lands in the past is not
seeding — it is rolling dice on the tester's behalf.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from support.schemas import invoice_schema, order_schema

from composer.protocol.models import FieldSpec, FieldType, Op1, PredicateClause
from composer.solving.predicates import (
    MARGIN_DAYS,
    ClauseSolution,
    ClauseUnsatisfiable,
    describe,
    holds,
    solve,
)
from composer.solving.sampler import ValueSampler

NOW = datetime(2026, 8, 1, 9, 0, tzinfo=UTC)


def field(name: str) -> FieldSpec:
    return next(spec for spec in order_schema().fields if spec.name == name)


def clause(field_name: str, op: str, operand: dict[str, object]) -> PredicateClause:
    return PredicateClause.model_validate({"field": field_name, "op": op, "operand": operand})


def sampler(seed: int = 3) -> ValueSampler:
    return ValueSampler(now=NOW, seed=seed)


def solved(outcome: object) -> ClauseSolution:
    assert isinstance(outcome, ClauseSolution)
    return outcome


def moment(value: object) -> datetime:
    assert isinstance(value, str)
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


# ── holds ─────────────────────────────────────────────────────────────────────────────────────


def test_a_temporal_clause_against_now() -> None:
    before = clause("dueAt", "lt", {"kind": "now", "offsetDays": 0})

    assert holds(before, "2026-07-01T09:00:00Z", NOW)
    assert not holds(before, "2026-09-01T09:00:00Z", NOW)


def test_a_now_clause_with_an_offset_moves_the_boundary() -> None:
    within_a_week = clause("dueAt", "gt", {"kind": "now", "offsetDays": -7})

    assert holds(within_a_week, "2026-07-30T09:00:00Z", NOW)
    assert not holds(within_a_week, "2026-07-01T09:00:00Z", NOW)


def test_a_temporal_clause_against_something_that_is_not_a_timestamp() -> None:
    assert not holds(clause("dueAt", "lt", {"kind": "now", "offsetDays": 0}), 42, NOW)


@pytest.mark.parametrize(
    ("op", "value", "expected"),
    [
        ("eq", "paid", True),
        ("eq", "draft", False),
        ("neq", "draft", True),
        ("neq", "paid", False),
    ],
)
def test_equality_clauses_against_a_literal(op: str, value: object, expected: bool) -> None:
    assert (
        holds(clause("status", op, {"kind": "literal", "value": "paid"}), value, NOW) is expected
    )


def test_ordering_clauses_against_numbers_and_timestamps() -> None:
    assert holds(clause("amount", "gt", {"kind": "literal", "value": 100}), 200, NOW)
    assert not holds(clause("amount", "gte", {"kind": "literal", "value": 300}), 200, NOW)
    assert holds(clause("amount", "lte", {"kind": "literal", "value": 200}), 200, NOW)
    assert holds(
        clause("dueAt", "lt", {"kind": "literal", "value": "2026-09-01T00:00:00Z"}),
        "2026-08-15T00:00:00Z",
        NOW,
    )


def test_ordering_two_things_that_have_no_ordering_does_not_hold() -> None:
    """Reported as not holding rather than raising.

    The caller turns it into a conflict naming the clause, which is more use to a tester than a
    stack trace out of the middle of a composition.
    """
    assert not holds(clause("terms", "gt", {"kind": "literal", "value": "net30"}), "net60", NOW)


# ── describe ──────────────────────────────────────────────────────────────────────────────────


def test_a_clause_is_described_with_now_resolved_to_the_instant_it_means() -> None:
    assert describe(clause("dueAt", "lt", {"kind": "now", "offsetDays": 0}), NOW) == (
        "dueAt to be before 2026-08-01T09:00:00Z (now)"
    )


def test_an_offset_clause_says_how_far_from_now_it_is() -> None:
    assert describe(clause("dueAt", "gte", {"kind": "now", "offsetDays": -30}), NOW) == (
        "dueAt to be no earlier than 2026-07-02T09:00:00Z (30 days before now)"
    )
    assert "30 days after now" in describe(
        clause("dueAt", "lt", {"kind": "now", "offsetDays": 30}), NOW
    )


def test_a_numeric_clause_reads_as_a_tester_would_say_it() -> None:
    assert describe(clause("amount", "gt", {"kind": "literal", "value": 500}), NOW) == (
        "amount to be over 500"
    )
    assert describe(clause("status", "neq", {"kind": "literal", "value": "paid"}), NOW) == (
        "status to be anything other than 'paid'"
    )


# ── solve: temporal ───────────────────────────────────────────────────────────────────────────


def test_overdue_back_dates_the_due_date() -> None:
    """§ 3's worked example: "overdue" ⇒ back-date `due_date` so the predicate holds."""
    before_now = clause("dueAt", "lt", {"kind": "now", "offsetDays": 0})
    outcome = solved(solve(before_now, field("dueAt"), now=NOW, current=None, sampler=sampler()))

    assert holds(before_now, outcome.value, NOW)
    assert outcome.field == "dueAt"
    assert "to be before" in outcome.requirement


def test_a_solved_date_clears_the_boundary_by_a_margin() -> None:
    """A due date set to *this instant* satisfies `dueAt < now()` when the plan is composed and
    fails it a second later when the record is created.

    The preview would have promised an overdue invoice and the application would hold a current
    one. The margin is the slack that survives however long the tester takes to read the preview.
    """
    spec = field("dueAt").model_copy(update={"distribution": None})
    outcome = solved(
        solve(
            clause("dueAt", "lt", {"kind": "now", "offsetDays": 0}),
            spec,
            now=NOW,
            current=None,
            sampler=sampler(),
        )
    )
    assert moment(outcome.value) <= NOW - timedelta(days=MARGIN_DAYS)


def test_a_value_that_already_satisfies_the_clause_is_kept() -> None:
    """A status the tester asked for, or one the sampler drew that happens to be fine, is not
    replaced just because a predicate mentions the field.

    Replacing it would be § 7's silent drop pointed at the tester's own words.
    """
    outcome = solved(
        solve(
            clause("dueAt", "lt", {"kind": "now", "offsetDays": 0}),
            field("dueAt"),
            now=NOW,
            current="2026-06-01T09:00:00Z",
            sampler=sampler(),
        )
    )
    assert outcome.value == "2026-06-01T09:00:00Z"


def test_a_temporal_solution_prefers_to_stay_inside_the_observed_range() -> None:
    # The fixture's invoices run 90 days behind to 45 days ahead; "before now" is satisfiable
    # inside that, so the solution does not step outside it.
    spec = next(entry for entry in invoice_schema().fields if entry.name == "dueAt")
    outcome = solved(
        solve(
            clause("dueAt", "lt", {"kind": "now", "offsetDays": 0}),
            spec,
            now=NOW,
            current=None,
            sampler=sampler(),
        )
    )
    assert not outcome.outside_observed_range
    assert NOW - timedelta(days=90) <= moment(outcome.value) <= NOW


def test_leaving_the_observed_range_is_allowed_and_recorded() -> None:
    """Where no value inside what the indexer saw can satisfy the clause, the clause still wins.

    The tester asked for the condition, not for a typical record. The solution records that it
    left the range so the provenance can say so, and the confidence it carries drops accordingly.
    """
    outcome = solved(
        solve(
            clause("dueAt", "gt", {"kind": "now", "offsetDays": 0}),
            field("dueAt"),  # observed entirely in the past: -147 to -0.7 days
            now=NOW,
            current=None,
            sampler=sampler(),
        )
    )
    assert outcome.outside_observed_range
    assert moment(outcome.value) > NOW


def test_an_equality_clause_on_a_date_lands_exactly_on_it() -> None:
    outcome = solved(
        solve(
            clause("dueAt", "eq", {"kind": "now", "offsetDays": -3}),
            field("dueAt"),
            now=NOW,
            current=None,
            sampler=sampler(),
        )
    )
    assert moment(outcome.value) == NOW - timedelta(days=3)


def test_a_date_inequality_clause_moves_off_the_forbidden_instant() -> None:
    forbidden = clause("dueAt", "neq", {"kind": "now", "offsetDays": 0})
    outcome = solved(solve(forbidden, field("dueAt"), now=NOW, current=None, sampler=sampler()))
    assert moment(outcome.value) != NOW


def test_a_time_comparison_against_a_field_that_is_not_a_date_is_unsatisfiable() -> None:
    outcome = solve(
        clause("status", "lt", {"kind": "now", "offsetDays": 0}),
        field("status"),
        now=NOW,
        current=None,
        sampler=sampler(),
    )
    assert isinstance(outcome, ClauseUnsatisfiable)
    assert "compares it against a point in time" in outcome.reason


# ── solve: literals ───────────────────────────────────────────────────────────────────────────


def test_an_equality_clause_takes_the_literal() -> None:
    outcome = solved(
        solve(
            clause("status", "eq", {"kind": "literal", "value": "pending"}),
            field("status"),
            now=NOW,
            current="shipped",
            sampler=sampler(),
        )
    )
    assert outcome.value == "pending"


def test_an_inequality_clause_redraws_until_it_avoids_the_value() -> None:
    forbidden = clause("status", "neq", {"kind": "literal", "value": "shipped"})
    for seed in range(25):
        outcome = solved(
            solve(forbidden, field("status"), now=NOW, current="shipped", sampler=sampler(seed))
        )
        assert outcome.value != "shipped"


def test_a_field_whose_whole_vocabulary_is_the_forbidden_value_is_unsatisfiable() -> None:
    """Saying so is more use than sampling forever.

    A field that only ever holds the one value the condition forbids cannot satisfy it, and the
    bound on the redraws is what makes that reportable rather than a hang.
    """
    spec = field("status").model_copy(
        update={"enum_values": [entry for entry in field("status").enum_values or []][:1]}
    )
    only_value = (spec.enum_values or [])[0].root

    outcome = solve(
        clause("status", "neq", {"kind": "literal", "value": only_value}),
        spec,
        now=NOW,
        current=only_value,
        sampler=sampler(),
    )
    assert isinstance(outcome, ClauseUnsatisfiable)
    assert "only ever holds" in outcome.reason


def test_a_numeric_bound_is_solved_inside_the_observed_range() -> None:
    spec = field("lineItems.amount")
    outcome = solved(
        solve(
            clause("lineItems.amount", "gt", {"kind": "literal", "value": 1000}),
            spec,
            now=NOW,
            current=None,
            sampler=sampler(),
        )
    )
    assert isinstance(outcome.value, float)
    assert outcome.value > 1000
    assert not outcome.outside_observed_range


def test_a_numeric_bound_outside_the_observed_range_is_still_satisfied() -> None:
    outcome = solved(
        solve(
            clause("lineItems.amount", "gt", {"kind": "literal", "value": 90_000}),
            field("lineItems.amount"),
            now=NOW,
            current=None,
            sampler=sampler(),
        )
    )
    assert isinstance(outcome.value, float)
    assert outcome.value > 90_000
    assert outcome.outside_observed_range


def test_an_integer_bound_is_solved_as_a_whole_number() -> None:
    spec = field("lineItems.amount").model_copy(update={"type": FieldType.INTEGER})
    outcome = solved(
        solve(
            clause("lineItems.amount", "gte", {"kind": "literal", "value": 500}),
            spec,
            now=NOW,
            current=None,
            sampler=sampler(),
        )
    )
    assert isinstance(outcome.value, int)
    assert outcome.value >= 500


def test_ordering_a_string_field_against_a_string_is_unsatisfiable() -> None:
    outcome = solve(
        clause("customer", "gt", {"kind": "literal", "value": "net30"}),
        field("customer"),
        now=NOW,
        current=None,
        sampler=sampler(),
    )
    assert isinstance(outcome, ClauseUnsatisfiable)
    assert "neither a number nor a timestamp" in outcome.reason


def test_a_literal_timestamp_bound_on_a_date_field() -> None:
    outcome = solved(
        solve(
            clause("dueAt", "lt", {"kind": "literal", "value": "2026-07-01T00:00:00Z"}),
            field("dueAt"),
            now=NOW,
            current=None,
            sampler=sampler(),
        )
    )
    assert moment(outcome.value) < datetime(2026, 7, 1, tzinfo=UTC)


def test_every_op_is_a_known_word() -> None:
    # A clause with no phrasing would render as a KeyError in front of a tester.
    for op in Op1:
        assert describe(clause("amount", op.value, {"kind": "literal", "value": 5}), NOW)
