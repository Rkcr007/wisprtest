"""Evaluating the derived-field rules the indexer learned.

Six rules, exactly the ones `DerivedRuleSpec` allows, because those are exactly the ones § 2.3
lets the observer infer — "not a general program synthesiser". The tests below are the mirror of
that constraint: they cover the six and assert that anything the rule cannot compute raises rather
than quietly leaving the field unset, because a derived field left unset is one the application
computes differently from the engine, and the preview would show a value the record does not have.
"""

from __future__ import annotations

import pytest
from support.schemas import order_schema

from composer.protocol.models import DerivedRule, FieldSpec
from composer.solving.derived import (
    Record,
    UnevaluableRuleError,
    dependencies,
    describe,
    evaluate,
    evaluation_order,
)


def field(name: str) -> FieldSpec:
    return next(spec for spec in order_schema().fields if spec.name == name)


def with_rule(name: str, rule: dict[str, object], *, confidence: float = 1.0) -> FieldSpec:
    """A field carrying one learned rule, built from the fixture so nothing is hand-shaped."""
    return field(name).model_copy(
        update={
            "derived_rule": DerivedRule.model_validate(
                {"rule": rule, "confidence": confidence, "sampleSize": 50}
            )
        }
    )


LINES: Record = {"lineItems": [{"amount": 100.0}, {"amount": 250.5}, {"amount": 49.5}]}


# ── The six rules ─────────────────────────────────────────────────────────────────────────────


def test_sum_over_a_group() -> None:
    # § 3's worked example: amount = Σ lines.
    assert evaluate(field("amount"), LINES) == 400.0


def test_count_over_a_group() -> None:
    spec = with_rule("amount", {"kind": "count", "overField": "lineItems"})
    assert evaluate(spec, LINES) == 3


def test_min_and_max_over_a_group() -> None:
    minimum = with_rule("amount", {"kind": "min", "overField": "lineItems", "ofField": "amount"})
    maximum = with_rule("amount", {"kind": "max", "overField": "lineItems", "ofField": "amount"})

    assert evaluate(minimum, LINES) == 49.5
    assert evaluate(maximum, LINES) == 250.5


def test_a_date_offset_from_another_field() -> None:
    spec = with_rule("dueAt", {"kind": "date_offset", "fromField": "createdAt", "offsetDays": 30})
    assert evaluate(spec, {"createdAt": "2026-08-01T09:00:00Z"}) == "2026-08-31T09:00:00Z"


def test_a_negative_date_offset() -> None:
    spec = with_rule("dueAt", {"kind": "date_offset", "fromField": "createdAt", "offsetDays": -7})
    assert evaluate(spec, {"createdAt": "2026-08-01T09:00:00Z"}) == "2026-07-25T09:00:00Z"


def test_concatenating_other_fields() -> None:
    spec = with_rule(
        "reference", {"kind": "concat", "fields": ["prefix", "serial"], "separator": "-"}
    )
    assert evaluate(spec, {"prefix": "ORD", "serial": 4903}) == "ORD-4903"


# ── Empty groups, and the difference between zero and undefined ───────────────────────────────


def test_an_empty_group_sums_to_zero() -> None:
    assert evaluate(field("amount"), {"lineItems": []}) == 0.0


def test_a_minimum_over_nothing_does_not_exist() -> None:
    # Zero would be a lie: it is a value the field does not have, and the application would
    # compute something else. Raising is the honest answer.
    spec = with_rule("amount", {"kind": "min", "overField": "lineItems", "ofField": "amount"})
    with pytest.raises(UnevaluableRuleError, match="lineItems is empty"):
        evaluate(spec, {"lineItems": []})


# ── What cannot be computed is said, not swallowed ────────────────────────────────────────────


def test_a_field_with_no_rule_is_not_this_module_s_business() -> None:
    with pytest.raises(UnevaluableRuleError, match="no derived rule"):
        evaluate(field("customer"), {})


def test_a_group_that_is_not_a_list() -> None:
    with pytest.raises(UnevaluableRuleError, match="not a repeated group"):
        evaluate(field("amount"), {"lineItems": "three"})


def test_a_group_member_with_no_numeric_value() -> None:
    with pytest.raises(UnevaluableRuleError, match="no numeric amount"):
        evaluate(field("amount"), {"lineItems": [{"amount": "lots"}]})


def test_a_date_offset_from_something_that_is_not_a_timestamp() -> None:
    spec = with_rule("dueAt", {"kind": "date_offset", "fromField": "createdAt", "offsetDays": 1})

    with pytest.raises(UnevaluableRuleError, match="not a timestamp"):
        evaluate(spec, {"createdAt": 20260801})
    with pytest.raises(UnevaluableRuleError, match="not an ISO 8601 timestamp"):
        evaluate(spec, {"createdAt": "the first of August"})


def test_a_concat_over_a_field_with_no_value_yet() -> None:
    spec = with_rule(
        "reference", {"kind": "concat", "fields": ["prefix", "serial"], "separator": "-"}
    )
    with pytest.raises(UnevaluableRuleError, match="serial has no value yet"):
        evaluate(spec, {"prefix": "ORD"})


# ── Dependencies and ordering ─────────────────────────────────────────────────────────────────


def test_dependencies_name_the_fields_a_rule_reads() -> None:
    assert dependencies(field("amount").derived_rule.rule) == ["lineItems"]  # type: ignore[union-attr]

    offset = with_rule("dueAt", {"kind": "date_offset", "fromField": "createdAt", "offsetDays": 1})
    assert dependencies(offset.derived_rule.rule) == ["createdAt"]  # type: ignore[union-attr]

    joined = with_rule("reference", {"kind": "concat", "fields": ["a", "b"], "separator": "-"})
    assert dependencies(joined.derived_rule.rule) == ["a", "b"]  # type: ignore[union-attr]


def test_evaluation_order_puts_a_rule_s_inputs_before_it() -> None:
    """A derived field can read another derived field, so the order is a dependency walk.

    Here `reference` is built from `amount`, which is itself the sum of the lines. Evaluating them
    in declaration order would concatenate an amount that had not been computed yet.
    """
    total = field("amount")
    label = with_rule(
        "reference", {"kind": "concat", "fields": ["amount", "customer"], "separator": "/"}
    )

    ordered = [spec.name for spec in evaluation_order([label, total, field("customer")])]
    assert ordered.index("amount") < ordered.index("reference")


def test_evaluation_order_ignores_fields_with_no_rule() -> None:
    ordered = evaluation_order(order_schema().fields)
    assert [spec.name for spec in ordered] == ["amount"]


def test_evaluation_order_terminates_on_a_cycle_rather_than_recursing_forever() -> None:
    """The observer refuses to record a cycle, so this is defence rather than a live case.

    A plain dependency walk on a cycle would recurse until the stack ran out; the `seen` set makes
    it emit both fields instead, and the one whose inputs are missing raises a readable error when
    it runs rather than being dropped from the record.
    """
    first = with_rule("amount", {"kind": "concat", "fields": ["reference", "x"], "separator": "-"})
    second = with_rule(
        "reference", {"kind": "concat", "fields": ["amount", "x"], "separator": "-"}
    )

    ordered = evaluation_order([first, second])
    assert sorted(spec.name for spec in ordered) == ["amount", "reference"]


# ── Explaining a rule to the tester ───────────────────────────────────────────────────────────


def test_describe_names_the_actual_group_size() -> None:
    """"the sum of amount across 3 lineItems", not "the sum of amount across lineItems".

    The number is what lets a tester check the arithmetic against the line items shown beside it,
    which is the difference between provenance and decoration.
    """
    assert describe(field("amount"), LINES) == "the sum of amount across 3 lineItems"


def test_describe_covers_every_rule_kind() -> None:
    count = with_rule("amount", {"kind": "count", "overField": "lineItems"})
    smallest = with_rule("amount", {"kind": "min", "overField": "lineItems", "ofField": "amount"})
    largest = with_rule("amount", {"kind": "max", "overField": "lineItems", "ofField": "amount"})
    ahead = with_rule("dueAt", {"kind": "date_offset", "fromField": "createdAt", "offsetDays": 30})
    behind = with_rule("dueAt", {"kind": "date_offset", "fromField": "createdAt", "offsetDays": -7})
    joined = with_rule("reference", {"kind": "concat", "fields": ["a", "b"], "separator": "-"})

    assert describe(count, LINES) == "the number of lineItems (3)"
    assert describe(smallest, LINES) == "the smallest of amount across 3 lineItems"
    assert describe(largest, LINES) == "the largest of amount across 3 lineItems"
    assert describe(ahead, {}) == "30 days after createdAt"
    assert describe(behind, {}) == "7 days before createdAt"
    assert describe(joined, {}) == "a, b joined by '-'"


def test_describe_needs_a_rule() -> None:
    with pytest.raises(UnevaluableRuleError):
        describe(field("customer"), {})
