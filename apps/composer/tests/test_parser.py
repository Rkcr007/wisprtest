"""`ConstraintParser` — utterance to `ConstraintSet`, and `choose_entity` in front of it.

The parser is the one place a tester's own words enter the engine, so the tests below are written
as sentences a tester would actually say rather than as inputs chosen to exercise branches. Two
properties matter more than any individual parse:

- **Nothing is silently dropped.** docs/TEST-DATA-ENGINE.md § 7. A clause the parser cannot map
  comes back in `unparsedFragments`, and the confidence drops to say so.
- **Nothing per-application is written down.** Every field name, enum value and predicate name in
  these assertions comes out of the fixture schema, never out of the parser.
"""

from __future__ import annotations

import pytest
from support.schemas import account_schema, invoice_schema, order_schema

from composer.parsing.parser import ConstraintParser, ParseResult, choose_entity
from composer.protocol.models import (
    ConstraintAlias,
    ConstraintCardinality,
    ConstraintComparison,
    ConstraintEquals,
    ConstraintPredicate,
    ConstraintReference,
    EntitySchema,
    Op,
)


def parse(utterance: str, *, aliases: list[ConstraintAlias] | None = None) -> ConstraintParser:
    return ConstraintParser(order_schema(), aliases or [])


def fragments(result: ParseResult) -> list[str]:
    """`unparsedFragments` as plain strings. The contract wraps each in a root model."""
    return [entry.root for entry in result.constraint_set.unparsed_fragments]


# ── choose_entity ─────────────────────────────────────────────────────────────────────────────


def test_the_utterance_names_the_entity() -> None:
    schemas = [account_schema(), order_schema()]
    chosen = choose_entity("I need an order", schemas, "/dashboard")
    assert chosen is not None
    assert chosen.entity_name == "Order"


def test_the_head_noun_wins_when_two_entities_are_named() -> None:
    """docs/TEST-DATA-ENGINE.md § 3's worked example, and the reason it is not ambiguous.

    "A customer with an overdue invoice" is a request for a customer; the invoice is a condition
    on it. Whichever entity is said first is the one being asked for, and the rest of the sentence
    describes it.
    """
    schemas = [invoice_schema(), account_schema()]

    head_is_account = choose_entity("an account with an overdue invoice", schemas, "/dashboard")
    head_is_invoice = choose_entity("an overdue invoice for an account", schemas, "/dashboard")

    assert head_is_account is not None and head_is_account.entity_name == "Account"
    assert head_is_invoice is not None and head_is_invoice.entity_name == "Invoice"


def test_the_route_decides_when_the_utterance_does_not() -> None:
    # The runtime state earning its place in the request: "one with three line items" spoken on
    # /orders is about an order.
    schemas = [account_schema(), order_schema()]
    chosen = choose_entity("one with three line items", schemas, "/orders")
    assert chosen is not None
    assert chosen.entity_name == "Order"


def test_a_single_candidate_needs_no_disambiguation() -> None:
    chosen = choose_entity("something entirely unrelated", [order_schema()], "/dashboard")
    assert chosen is not None
    assert chosen.entity_name == "Order"


def test_refuses_to_guess_between_several_unnamed_candidates() -> None:
    # An engine that composes the wrong entity has not misunderstood a detail; it has answered a
    # different question. None is the honest answer.
    assert choose_entity("something unrelated", [account_schema(), order_schema()], "/x") is None


# ── The five constraint kinds ─────────────────────────────────────────────────────────────────


def test_the_worked_example_from_the_design_doc() -> None:
    """"I need a pending order for Acme Industrial with three line items" — § 3, verbatim.

    Three constraints of three different kinds out of one sentence, nothing left unparsed.
    """
    result = parse("I need a pending order for Acme Industrial with three line items").parse(
        "I need a pending order for Acme Industrial with three line items"
    )
    constraints = result.constraint_set.constraints

    assert ConstraintEquals(kind="equals", field="status", value="pending") in constraints
    assert ConstraintCardinality(kind="cardinality", field="lineItems", count=3) in constraints
    assert (
        ConstraintReference(kind="reference", field="accountId", phrase="acme industrial")
        in constraints
    )
    assert fragments(result) == []
    assert result.tier == "T0"


@pytest.mark.parametrize(
    ("utterance", "op", "value"),
    [
        ("an order over 50000", Op.GT, 50_000.0),
        ("an order under £1,000", Op.LT, 1_000.0),
        ("an order of at least 2.5k", Op.GTE, 2_500.0),
        ("an order at most $900", Op.LTE, 900.0),
        ("an order worth more than 1.2m", Op.GT, 1_200_000.0),
    ],
)
def test_comparisons_attach_to_the_one_numeric_field(
    utterance: str, op: Op, value: float
) -> None:
    result = parse(utterance).parse(utterance)
    assert ConstraintComparison(kind="comparison", field="amount", op=op, value=value) in (
        result.constraint_set.constraints
    )


@pytest.mark.parametrize(
    ("utterance", "count"),
    [
        ("an order with three line items", 3),
        ("an order with 7 line items", 7),
        ("an order with a couple of line items", 2),
        ("an order with several line items", 3),
        ("an order with no line items", 0),
    ],
)
def test_cardinality_reads_counts_spoken_as_words_or_digits(utterance: str, count: int) -> None:
    result = parse(utterance).parse(utterance)
    assert ConstraintCardinality(kind="cardinality", field="lineItems", count=count) in (
        result.constraint_set.constraints
    )


def test_a_count_with_nothing_countable_beside_it_is_not_a_cardinality() -> None:
    # "three" next to a scalar field is not a cardinality. It is either a value or something the
    # parser should admit it did not understand — never a silently invented group size.
    result = parse("an order with three").parse("an order with three")
    assert not [
        entry
        for entry in result.constraint_set.constraints
        if isinstance(entry, ConstraintCardinality)
    ]


def test_learned_predicates_are_read_before_field_values() -> None:
    result = parse("an overdue order").parse("an overdue order")
    assert ConstraintPredicate(kind="predicate", name="overdue") in (
        result.constraint_set.constraints
    )


def test_a_predicate_of_a_related_entity_is_read_and_its_entity_name_claimed() -> None:
    """"An account with an overdue invoice": `overdue` is learned on `Invoice`, not on `Account`.

    A parser that could only see the head noun's own predicates would report the most interesting
    half of that sentence as an unparsed fragment, and the solver would never build the graph § 3
    describes.
    """
    parser = ConstraintParser(account_schema(), [], [invoice_schema()])
    result = parser.parse("an account with an overdue invoice")

    assert ConstraintPredicate(kind="predicate", name="overdue") in (
        result.constraint_set.constraints
    )
    # `invoice` says which record the condition is about; it is accounted for, not leftover.
    assert fragments(result) == []


def test_enum_values_are_matched_against_the_learned_vocabulary_only() -> None:
    result = parse("a cancelled order on net60 terms").parse("a cancelled order on net60 terms")
    constraints = result.constraint_set.constraints

    assert ConstraintEquals(kind="equals", field="status", value="cancelled") in constraints
    assert ConstraintEquals(kind="equals", field="terms", value="net60") in constraints


def test_a_value_outside_the_learned_vocabulary_is_not_invented() -> None:
    result = parse("an escalated order").parse("an escalated order")
    assert not [
        entry
        for entry in result.constraint_set.constraints
        if isinstance(entry, ConstraintEquals) and entry.field == "status"
    ]


def test_a_reference_phrase_stops_at_the_next_clause() -> None:
    # "for Acme Industrial with three line items" names Acme, not the whole rest of the sentence.
    result = parse("an order for Acme Industrial with three line items").parse(
        "an order for Acme Industrial with three line items"
    )
    references = [
        entry
        for entry in result.constraint_set.constraints
        if isinstance(entry, ConstraintReference)
    ]
    assert [entry.phrase for entry in references] == ["acme industrial"]


# ── Tiers, aliases and the write-back loop ────────────────────────────────────────────────────


def test_a_learned_alias_is_answered_at_t0() -> None:
    """The write-back loop closing: a phrasing somebody already paid a model call for.

    CLAUDE.md § "Resolution tiers": the second tester to say "high value" gets the answer free.
    """
    alias = ConstraintAlias.model_validate(
        {
            "phrase": "high value",
            "entity": "Order",
            "constraints": [{"kind": "comparison", "field": "amount", "op": "gt", "value": 50000}],
            "source": "t2_writeback",
            "confidence": 0.9,
        }
    )
    result = parse("a high value order", aliases=[alias]).parse("a high value order")

    assert (
        ConstraintComparison(kind="comparison", field="amount", op=Op.GT, value=50_000.0)
        in result.constraint_set.constraints
    )
    assert result.tier == "T0"


def test_an_alias_for_another_entity_is_ignored() -> None:
    alias = ConstraintAlias.model_validate(
        {
            "phrase": "high value",
            "entity": "Invoice",
            "constraints": [{"kind": "comparison", "field": "total", "op": "gt", "value": 1}],
            "source": "manual",
            "confidence": 0.9,
        }
    )
    result = parse("a high value order", aliases=[alias]).parse("a high value order")
    assert result.constraint_set.constraints == []


def test_a_near_miss_on_a_vocabulary_entry_is_caught_locally_at_t1() -> None:
    """T1 is what stops a word order slip costing a model call.

    The fixture's `Order` has no multi-word enum value, so the near-miss is built from one that
    does: an entity whose vocabulary the tester says loosely still resolves without escalation.
    """
    schema = EntitySchema.model_validate(
        {
            **order_schema().model_dump(mode="json", by_alias=True),
            "fields": [
                {
                    **order_schema().fields[2].model_dump(mode="json", by_alias=True),
                    "name": "status",
                    "enumValues": ["pending approval", "approved"],
                    "distribution": None,
                }
            ],
        }
    )
    result = ConstraintParser(schema, []).parse("approval pending order")

    assert ConstraintEquals(kind="equals", field="status", value="pending approval") in (
        result.constraint_set.constraints
    )
    assert result.tier == "T1"


# ── What went unread ──────────────────────────────────────────────────────────────────────────


def test_an_unmapped_clause_is_reported_rather_than_dropped() -> None:
    """§ 7, the whole reason `unparsedFragments` exists.

    A tester finds out "with the usual terms" was ignored *before* approving the record, not after
    discovering the record does not have the terms they meant.
    """
    result = parse("an order with the usual paperwork").parse("an order with the usual paperwork")
    assert fragments(result) == ["usual paperwork"]


def test_an_unparsed_fragment_lowers_confidence() -> None:
    clean = parse("a pending order").parse("a pending order")
    ragged = parse("a pending order with the usual paperwork").parse(
        "a pending order with the usual paperwork"
    )
    assert ragged.constraint_set.confidence < clean.constraint_set.confidence


def test_an_utterance_nothing_could_be_read_from_scores_zero() -> None:
    result = parse("something entirely unrelated").parse("something entirely unrelated")
    assert result.constraint_set.constraints == []
    assert result.constraint_set.confidence == 0.0


def test_bare_field_names_beside_a_parsed_clause_are_not_reported_as_unread() -> None:
    # "net60 terms" names the field beside the value. Reporting `terms` as unparsed would cry wolf
    # on almost every utterance and teach testers to ignore the warning that matters.
    result = parse("an order on net60 terms").parse("an order on net60 terms")
    assert fragments(result) == []
