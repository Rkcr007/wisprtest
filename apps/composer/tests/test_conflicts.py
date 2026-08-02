"""`find_conflict` — the contradictions that can be seen before any value is drawn.

docs/TEST-DATA-ENGINE.md § 7 gives this its whole specification: "report the conflict in plain
language; never silently drop a constraint". Every test below therefore asserts two things — that
the collision was *found*, and that the explanation names both halves of it. A conflict a tester
cannot act on is only marginally better than no conflict at all.
"""

from __future__ import annotations

from support.schemas import order_schema

from composer.protocol.models import (
    ConflictSideConstraint,
    ConflictSideSchema,
    ConstraintCardinality,
    ConstraintComparison,
    ConstraintEquals,
    ConstraintPredicate,
    Op,
)
from composer.solving.conflicts import find_conflict
from composer.solving.types import Constraint


def comparison(field: str, op: Op, value: float) -> ConstraintComparison:
    return ConstraintComparison(kind="comparison", field=field, op=op, value=value)


def equals(field: str, value: object) -> ConstraintEquals:
    return ConstraintEquals(kind="equals", field=field, value=value)


def find(constraints: list[Constraint]) -> object:
    return find_conflict(order_schema(), constraints)


# ── Two bounds with nothing between them ──────────────────────────────────────────────────────


def test_over_fifty_thousand_and_under_one_thousand() -> None:
    conflict = find([comparison("amount", Op.GT, 50_000), comparison("amount", Op.LT, 1_000)])

    assert conflict is not None
    assert conflict.field == "amount"
    assert "cannot be both over 50,000 and under 1,000" in conflict.explanation
    assert isinstance(conflict.left, ConflictSideConstraint)
    assert isinstance(conflict.right, ConflictSideConstraint)


def test_bounds_that_leave_room_are_not_a_conflict() -> None:
    assert find([comparison("amount", Op.GT, 1_000), comparison("amount", Op.LT, 50_000)]) is None


def test_bounds_that_meet_at_one_satisfiable_value_are_not_a_conflict() -> None:
    # `>= 5 and <= 5` is satisfiable by exactly 5. Reporting it would be a false positive on a
    # perfectly ordinary way of asking for an exact amount.
    assert find([comparison("amount", Op.GTE, 5), comparison("amount", Op.LTE, 5)]) is None


def test_a_strict_bound_meeting_an_inclusive_one_is_a_conflict() -> None:
    assert find([comparison("amount", Op.GT, 5), comparison("amount", Op.LTE, 5)]) is not None


def test_bounds_on_different_fields_do_not_collide() -> None:
    assert find([comparison("amount", Op.GT, 50_000), comparison("dueAt", Op.LT, 1)]) is None


# ── A value its own bound rules out ───────────────────────────────────────────────────────────


def test_an_explicit_value_outside_its_own_comparison() -> None:
    conflict = find([equals("amount", 200), comparison("amount", Op.GT, 50_000)])

    assert conflict is not None
    assert "asked for as 200" in conflict.explanation
    assert "not over 50,000" in conflict.explanation


def test_an_explicit_value_inside_its_comparison_is_fine() -> None:
    assert find([equals("amount", 60_000), comparison("amount", Op.GT, 50_000)]) is None


def test_a_non_numeric_value_is_not_compared_against_a_numeric_bound_here() -> None:
    # Left to the solver, which knows the field's type. This function only decides what can be
    # decided from the constraints themselves.
    assert find([equals("status", "pending"), comparison("amount", Op.GT, 1)]) is None


# ── A value the learned vocabulary does not contain ───────────────────────────────────────────


def test_a_value_outside_the_learned_vocabulary_names_what_is_valid() -> None:
    """"escalated is not a valid status" is only half an answer.

    The tester needs to know what *is* valid, and the learned set is exactly that — which is also
    the proof that the vocabulary is per-application data rather than anything written down here.
    """
    conflict = find([equals("status", "escalated")])

    assert conflict is not None
    assert conflict.field == "status"
    assert isinstance(conflict.right, ConflictSideSchema)
    assert conflict.right.detail == "accepts only approved, cancelled, pending, shipped"
    assert "this application only uses approved, cancelled, pending, shipped" in (
        conflict.explanation
    )


def test_a_value_inside_the_learned_vocabulary_is_fine() -> None:
    assert find([equals("status", "shipped")]) is None


def test_a_field_with_no_vocabulary_accepts_anything() -> None:
    assert find([equals("customer", "anything at all")]) is None


# ── A predicate against a value said in the same breath ───────────────────────────────────────


def test_a_shipped_order_that_is_overdue() -> None:
    """Both halves are individually reasonable, which is what makes this worth checking.

    The fixture learned `overdue` as `dueAt < now AND status != shipped`. Without this check the
    solver would satisfy whichever it applied last and hand back a record that quietly fails the
    predicate the tester actually cared about.
    """
    conflict = find(
        [ConstraintPredicate(kind="predicate", name="overdue"), equals("status", "shipped")]
    )

    assert conflict is not None
    assert conflict.field == "status"
    assert "'overdue' requires that status is not 'shipped'" in conflict.explanation


def test_a_predicate_with_a_compatible_value_is_fine() -> None:
    assert (
        find([ConstraintPredicate(kind="predicate", name="overdue"), equals("status", "pending")])
        is None
    )


def test_an_unknown_predicate_is_not_treated_as_a_conflict() -> None:
    # It may belong to a related entity. The solver decides; this function does not guess.
    assert find([ConstraintPredicate(kind="predicate", name="expired")]) is None


# ── Reporting discipline ──────────────────────────────────────────────────────────────────────


def test_only_the_first_conflict_is_reported() -> None:
    """A tester fixes one thing at a time.

    A list of six conflicts, most of them consequences of the first, is harder to act on than the
    one that matters. The next composition finds the next one.
    """
    conflict = find(
        [
            comparison("amount", Op.GT, 50_000),
            comparison("amount", Op.LT, 1_000),
            equals("status", "escalated"),
        ]
    )
    assert conflict is not None
    assert conflict.field == "amount"


def test_a_satisfiable_set_produces_nothing() -> None:
    assert (
        find(
            [
                equals("status", "pending"),
                comparison("amount", Op.GT, 1_000),
                ConstraintCardinality(kind="cardinality", field="lineItems", count=3),
            ]
        )
        is None
    )


def test_an_empty_set_produces_nothing() -> None:
    assert find([]) is None
