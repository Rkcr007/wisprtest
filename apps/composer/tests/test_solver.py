"""`ConstraintSolver` — a constraint set becomes a graph of records, or an honest refusal.

The tests are organised by the five stages docs/TEST-DATA-ENGINE.md § 3 fixes, because the order
is the design rather than a preference, and most of what can go wrong here is a later stage
stamping on an earlier one. The last two sections are the ones that matter most:

- **Nothing is silently dropped** (§ 7). Every constraint is re-checked against the finished
  record, and a requirement that stopped holding is reported instead of shipped.
- **The output is a graph** (§ 3). "A customer with an overdue invoice" is two records with an
  edge between them, and Account is created first.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from support.schemas import account_schema, accounts, invoice_schema, order_schema

from composer.protocol.models import (
    ConstraintCardinality,
    ConstraintComparison,
    ConstraintEquals,
    ConstraintPredicate,
    ConstraintReference,
    EntitySchema,
    ExistingRecord,
    Mode,
    Op,
    ProvenanceSource,
)
from composer.solving.graph import PlanNode
from composer.solving.predicates import holds
from composer.solving.sampler import ValueSampler
from composer.solving.solver import (
    MAX_REFERENCE_DEPTH,
    Conflicted,
    ConstraintSolver,
    Refused,
    SolveOutcome,
    Solved,
)
from composer.solving.types import Constraint

NOW = datetime(2026, 8, 1, 9, 0, tzinfo=UTC)


def solver(
    *,
    schemas: list[EntitySchema] | None = None,
    records: list[ExistingRecord] | None = None,
    utterance: str = "an order",
    seed: int = 5,
) -> ConstraintSolver:
    return ConstraintSolver(
        schemas=schemas if schemas is not None else [order_schema(), account_schema()],
        existing_records=records if records is not None else accounts(),
        utterance=utterance,
        now=NOW,
        sampler=ValueSampler(now=NOW, seed=seed),
        parse_confidence=0.95,
    )


def solve(constraints: list[Constraint], **kwargs: object) -> SolveOutcome:
    schemas = kwargs.pop("schemas", None)
    root = kwargs.pop("root", None)
    built = solver(**kwargs)  # type: ignore[arg-type]
    if schemas is not None:
        built = solver(schemas=schemas, **kwargs)  # type: ignore[arg-type]
    assert isinstance(root, EntitySchema | None)
    return built.solve(root if root is not None else order_schema(), constraints)


def planned(outcome: SolveOutcome) -> Solved:
    assert isinstance(outcome, Solved), outcome
    return outcome


def root_of(outcome: SolveOutcome) -> PlanNode:
    plan = planned(outcome)
    return plan.graph.node(plan.root_node_id)


def source_of(node: PlanNode, field: str) -> ProvenanceSource:
    return next(entry.source for entry in node.provenance if entry.field == field)


def equals(field: str, value: object) -> ConstraintEquals:
    return ConstraintEquals(kind="equals", field=field, value=value)


def comparison(field: str, op: Op, value: float) -> ConstraintComparison:
    return ConstraintComparison(kind="comparison", field=field, op=op, value=value)


# ── (a) Explicit constraints ──────────────────────────────────────────────────────────────────


def test_an_explicit_value_is_used_verbatim_and_marked_requested() -> None:
    node = root_of(solve([equals("status", "pending")]))

    assert node.fields["status"] == "pending"
    assert source_of(node, "status") is ProvenanceSource.REQUESTED


def test_a_spoken_bound_produces_a_value_that_satisfies_it() -> None:
    node = root_of(solve([comparison("lineItems.amount", Op.GT, 1_000)]))
    value = node.fields["lineItems.amount"]

    assert isinstance(value, float)
    assert value > 1_000


def test_a_strict_bound_is_cleared_rather_than_met_exactly() -> None:
    """"Over 50,000" that returns exactly 50,000 is the kind of off-by-one a tester only
    discovers when the assertion they were testing passes for the wrong reason."""
    for seed in range(15):
        node = root_of(solve([comparison("lineItems.amount", Op.GT, 2_000)], seed=seed))
        value = node.fields["lineItems.amount"]
        assert isinstance(value, float)
        assert value > 2_000


def test_two_bounds_are_both_honoured() -> None:
    node = root_of(
        solve([comparison("lineItems.amount", Op.GTE, 500), comparison(
            "lineItems.amount", Op.LTE, 800
        )])
    )
    value = node.fields["lineItems.amount"]
    assert isinstance(value, float)
    assert 500 <= value <= 800


def test_a_bound_on_a_field_with_no_ordering_is_a_conflict() -> None:
    outcome = solve([comparison("terms", Op.GT, 5)])
    assert isinstance(outcome, Conflicted)
    assert "stores it as enum" in outcome.conflict.explanation


def test_a_constraint_naming_a_field_the_schema_does_not_have_is_refused() -> None:
    outcome = solve([equals("shippingWeight", 4)])
    assert isinstance(outcome, Refused)
    assert outcome.missing_fields == ["shippingWeight"]
    assert "records no such field" in outcome.reason


# ── (b) References ────────────────────────────────────────────────────────────────────────────


def test_a_named_reference_resolves_to_the_real_record() -> None:
    outcome = solve(
        [ConstraintReference(kind="reference", field="accountId", phrase="acme industrial")]
    )
    node = root_of(outcome)

    assert node.fields["accountId"] == "ACC-1001"
    assert source_of(node, "accountId") is ProvenanceSource.REFERENCE_MATCHED


def test_a_reused_record_becomes_a_node_the_preview_can_show() -> None:
    plan = planned(
        solve([ConstraintReference(kind="reference", field="accountId", phrase="acme")])
    )
    reused = [node for node in plan.graph.nodes() if node.mode is Mode.REUSE_EXISTING]

    assert len(reused) == 1
    assert reused[0].existing_external_ref == "ACC-1001"
    assert reused[0].fields == {}


def test_a_required_reference_nobody_mentioned_reuses_something_that_exists() -> None:
    # § 3: "prefer an existing real record". The tester said nothing about an account, and
    # creating a second one would leave a duplicate behind that somebody has to clean up.
    node = root_of(solve([]))
    assert isinstance(node.fields["accountId"], str)
    assert node.fields["accountId"].startswith("ACC-")


def test_a_reference_that_matches_nothing_becomes_a_second_record() -> None:
    outcome = solve(
        [ConstraintReference(kind="reference", field="accountId", phrase="never heard of them")]
    )
    plan = planned(outcome)
    created = [node for node in plan.graph.nodes() if node.mode is Mode.CREATE]

    assert [node.schema.entity_name for node in created] == ["Order", "Account"]
    # The new account is given the name the tester said, in the field the records revealed.
    assert plan.graph.node("account-1").fields["name"] == "never heard of them"


def test_a_pending_reference_holds_no_value_and_says_where_one_comes_from() -> None:
    outcome = solve(
        [ConstraintReference(kind="reference", field="accountId", phrase="never heard of them")]
    )
    node = root_of(outcome)

    assert node.fields["accountId"] is None
    assert source_of(node, "accountId") is ProvenanceSource.DEFAULT
    assert "account-1" in next(
        entry.explanation for entry in node.provenance if entry.field == "accountId"
    )


def test_novelty_in_the_utterance_creates_rather_than_reuses() -> None:
    outcome = solve([], utterance="a new order for a new account")
    plan = planned(outcome)

    assert [node.mode for node in plan.graph.nodes()] == [Mode.CREATE, Mode.CREATE]


def test_novelty_attaches_to_the_noun_it_is_next_to() -> None:
    # "A new order for Acme Industrial" creates the order and reuses the account.
    node = root_of(solve([], utterance="a new order for acme industrial"))
    assert node.fields["accountId"] == "ACC-1001"


def test_a_reference_with_no_records_and_no_schema_is_refused() -> None:
    outcome = solve([], schemas=[order_schema()], records=[])
    assert isinstance(outcome, Refused)
    assert outcome.missing_fields == ["accountId"]
    assert "holds no schema for Account" in outcome.reason


def test_creating_a_named_reference_needs_to_know_which_field_holds_the_name() -> None:
    """`label_field` returning None means the records do not reveal a display field.

    Creating the record anyway would silently drop the name the tester said, so this refuses and
    says which field it could not fill.
    """
    unlabelled = [
        ExistingRecord.model_validate(
            {"entity": "Account", "externalRef": "ACC-1", "label": None, "fields": {"x": 1}}
        )
    ]
    outcome = solve(
        [ConstraintReference(kind="reference", field="accountId", phrase="acme industrial")],
        records=unlabelled,
    )

    assert isinstance(outcome, Refused)
    assert "cannot be created with the name you said" in outcome.reason


def test_a_reference_chain_that_points_back_at_itself_is_refused() -> None:
    """A record cannot be created before itself, and a cycle has no materialization order.

    Refusing names the field that caused it, which is a fix somebody can act on; the alternative
    is a plan the gateway cannot execute.
    """
    self_referential = EntitySchema.model_validate(
        {
            **account_schema().model_dump(mode="json", by_alias=True),
            "fields": [
                {
                    **account_schema().fields[0].model_dump(mode="json", by_alias=True),
                    "name": "parentId",
                    "type": "reference",
                    "required": True,
                    "referencesEntity": "Account",
                    "distribution": None,
                }
            ],
        }
    )
    outcome = solve([], schemas=[self_referential], records=[], root=self_referential)

    assert isinstance(outcome, Refused)
    assert "already being created in this plan" in outcome.reason


def test_a_chain_of_required_references_is_not_followed_forever() -> None:
    """More records than the tester asked for is its own failure mode.

    A required reference chain deeper than the limit is almost always a schema the indexer read
    wrong, and a plan asking somebody to approve a dozen records they never mentioned is not a
    preview they can meaningfully approve.
    """
    chain = [
        EntitySchema.model_validate(
            {
                **account_schema().model_dump(mode="json", by_alias=True),
                "entityName": f"Level{index}",
                "fields": [
                    {
                        **account_schema().fields[0].model_dump(mode="json", by_alias=True),
                        "name": "parentId",
                        "type": "reference",
                        "required": True,
                        "referencesEntity": f"Level{index + 1}",
                        "distribution": None,
                    }
                ],
            }
        )
        for index in range(MAX_REFERENCE_DEPTH + 2)
    ]
    outcome = solve([], schemas=chain, records=[], root=chain[0])

    assert isinstance(outcome, Refused)
    assert f"more than {MAX_REFERENCE_DEPTH} deep" in outcome.reason


# ── (c) Required-but-unspecified ──────────────────────────────────────────────────────────────


def test_every_required_field_is_filled() -> None:
    node = root_of(solve([]))
    required = [
        spec.name for spec in order_schema().fields if spec.required and "." not in spec.name
    ]
    assert all(name in node.fields for name in required)


def test_an_optional_field_nobody_mentioned_is_left_out() -> None:
    # Filling everything would put values in the record that nothing asked for, and the tester
    # would have to decide, field by field, which of them mattered.
    node = root_of(solve([]))
    assert "terms" not in node.fields


def test_a_derived_field_s_inputs_are_pulled_in_even_when_optional() -> None:
    """"Needed" is wider than "required".

    `amount` is required and computed as the sum of `lineItems`; `lineItems` is optional. Filling
    only what is flagged required would leave the sum with nothing to add up and send the
    application a total of zero.
    """
    node = root_of(solve([]))
    assert isinstance(node.fields["lineItems"], list)
    assert node.fields["lineItems"]


def test_a_group_size_nobody_stated_comes_from_the_observed_shape() -> None:
    # The fixture's orders carry one to five lines; a seeded order carrying forty would not look
    # like anything this application has ever held.
    for seed in range(20):
        node = root_of(solve([], seed=seed))
        members = node.fields["lineItems"]
        assert isinstance(members, list)
        assert 1 <= len(members) <= 5


def test_group_members_are_drawn_from_the_member_field_s_own_distribution() -> None:
    node = root_of(solve([ConstraintCardinality(kind="cardinality", field="lineItems", count=3)]))
    members = node.fields["lineItems"]

    assert isinstance(members, list)
    assert [sorted(row) for row in members] == [["amount"]] * 3
    for row in members:
        assert 67.55 <= row["amount"] <= 3893.33


def test_the_same_seed_composes_the_same_record_twice() -> None:
    first = root_of(solve([], seed=99))
    second = root_of(solve([], seed=99))
    assert first.fields == second.fields


# ── (d) Predicates ────────────────────────────────────────────────────────────────────────────


def test_a_predicate_is_made_true_rather_than_checked() -> None:
    outcome = solve([ConstraintPredicate(kind="predicate", name="overdue")])
    node = root_of(outcome)

    for clause in order_schema().predicates[0].clauses:
        assert holds(clause, node.fields.get(clause.field), NOW)


def test_a_predicate_solved_field_is_marked_as_such() -> None:
    node = root_of(solve([ConstraintPredicate(kind="predicate", name="overdue")]))
    assert source_of(node, "dueAt") is ProvenanceSource.PREDICATE_SOLVED


def test_a_predicate_never_overwrites_a_value_the_tester_asked_for() -> None:
    """§ 7's silent drop, pointed at the tester's own words.

    "A shipped order that is overdue" cannot be satisfied — the fixture learned `overdue` as
    `status != shipped`. Quietly setting the status to something else would hand back a record
    that is not the one they asked for.
    """
    outcome = solve(
        [ConstraintPredicate(kind="predicate", name="overdue"), equals("status", "shipped")]
    )

    assert isinstance(outcome, Conflicted)
    assert outcome.conflict.field == "status"
    assert "you asked for status to be 'shipped'" in outcome.conflict.explanation


def test_a_predicate_keeps_a_requested_value_that_already_satisfies_it() -> None:
    outcome = solve(
        [ConstraintPredicate(kind="predicate", name="overdue"), equals("status", "pending")]
    )
    node = root_of(outcome)

    assert node.fields["status"] == "pending"
    assert source_of(node, "status") is ProvenanceSource.REQUESTED


def test_a_predicate_that_cannot_be_arranged_is_reported_as_a_conflict() -> None:
    only_shipped = EntitySchema.model_validate(
        {
            **order_schema().model_dump(mode="json", by_alias=True),
            "fields": [
                {
                    **spec.model_dump(mode="json", by_alias=True),
                    **({"enumValues": ["shipped"], "distribution": None}
                       if spec.name == "status" else {}),
                }
                for spec in order_schema().fields
            ],
        }
    )
    outcome = solve(
        [ConstraintPredicate(kind="predicate", name="overdue")],
        schemas=[only_shipped, account_schema()],
        root=only_shipped,
    )

    assert isinstance(outcome, Conflicted)
    assert "only ever holds 'shipped'" in outcome.conflict.explanation


def test_a_predicate_nothing_knows_about_is_refused() -> None:
    outcome = solve([ConstraintPredicate(kind="predicate", name="expired")])
    assert isinstance(outcome, Refused)
    assert "not a condition this memory version knows about" in outcome.reason


# ── (e) Derived rules, last ───────────────────────────────────────────────────────────────────


def test_a_derived_field_is_computed_from_the_values_finally_chosen() -> None:
    node = root_of(solve([ConstraintCardinality(kind="cardinality", field="lineItems", count=4)]))
    members = node.fields["lineItems"]

    assert isinstance(members, list)
    assert node.fields["amount"] == pytest.approx(
        round(sum(float(row["amount"]) for row in members), 2)
    )
    assert source_of(node, "amount") is ProvenanceSource.DERIVED


def test_a_bound_on_a_computed_field_is_satisfied_through_its_inputs() -> None:
    """"An order over £50,000" when the total is the sum of the line items.

    The tester cannot set the total — the application recomputes it — so the only honest way to
    satisfy the request is to work backwards into the lines and then compute forwards again.
    """
    node = root_of(solve([comparison("amount", Op.GT, 50_000)]))
    members = node.fields["lineItems"]

    assert isinstance(members, list)
    assert isinstance(node.fields["amount"], float)
    assert node.fields["amount"] > 50_000
    assert node.fields["amount"] == pytest.approx(
        round(sum(float(row["amount"]) for row in members), 2)
    )


def test_an_exact_value_for_a_computed_field_is_reached_through_its_inputs() -> None:
    node = root_of(
        solve(
            [
                equals("amount", 900.0),
                ConstraintCardinality(kind="cardinality", field="lineItems", count=3),
            ]
        )
    )
    assert node.fields["amount"] == 900.0
    assert source_of(node, "lineItems") is ProvenanceSource.REQUESTED


def test_a_computed_field_that_cannot_reach_the_requested_value_reports_the_collision() -> None:
    """Never quietly resolved in favour of the arithmetic.

    A `count` is not invertible into a value: the tester asked for one thing, the application
    computes another, and saying which two collide is the only answer that does not mislead.
    """
    counted = EntitySchema.model_validate(
        {
            **order_schema().model_dump(mode="json", by_alias=True),
            "fields": [
                {
                    **spec.model_dump(mode="json", by_alias=True),
                    **(
                        {"derivedRule": {
                            "rule": {"kind": "count", "overField": "lineItems"},
                            "confidence": 1.0,
                            "sampleSize": 50,
                        }}
                        if spec.name == "amount"
                        else {}
                    ),
                }
                for spec in order_schema().fields
            ],
        }
    )
    outcome = solve(
        [
            equals("amount", 99),
            ConstraintCardinality(kind="cardinality", field="lineItems", count=3),
        ],
        schemas=[counted, account_schema()],
        root=counted,
    )

    assert isinstance(outcome, Conflicted)
    assert "this application computes it as the number of lineItems" in (
        outcome.conflict.explanation
    )


def test_a_derived_field_whose_inputs_cannot_be_computed_is_refused() -> None:
    broken = EntitySchema.model_validate(
        {
            **order_schema().model_dump(mode="json", by_alias=True),
            "fields": [
                {
                    **spec.model_dump(mode="json", by_alias=True),
                    **(
                        {"derivedRule": {
                            "rule": {
                                "kind": "date_offset",
                                "fromField": "createdAt",
                                "offsetDays": 30,
                            },
                            "confidence": 1.0,
                            "sampleSize": 50,
                        }}
                        if spec.name == "amount"
                        else {}
                    ),
                }
                for spec in order_schema().fields
            ],
        }
    )
    outcome = solve([], schemas=[broken, account_schema()], root=broken)

    assert isinstance(outcome, Refused)
    assert outcome.missing_fields == ["amount"]
    assert "computed by this application" in outcome.reason


# ── The graph ─────────────────────────────────────────────────────────────────────────────────


def test_a_customer_with_an_overdue_invoice_produces_account_then_invoice() -> None:
    """docs/TEST-DATA-ENGINE.md § 3's worked example, end to end.

    `overdue` is a predicate on `Invoice`; the head noun is the account. The solver walks the
    referential graph from `Invoice.accountId` back to the `Account` it was asked about, and
    produces two records with the edge that orders them.
    """
    outcome = solve(
        [ConstraintPredicate(kind="predicate", name="overdue")],
        schemas=[account_schema(), invoice_schema()],
        records=[],
        utterance="an account with an overdue invoice",
        root=account_schema(),
    )
    plan = planned(outcome)

    assert plan.root_node_id == "account-1"
    assert plan.graph.materialization_order() == ["account-1", "invoice-1"]

    edge = plan.graph.edges()[0]
    assert (edge.from_node_id, edge.to_node_id, edge.via_field) == (
        "invoice-1",
        "account-1",
        "accountId",
    )

    invoice = plan.graph.node("invoice-1")
    for clause in invoice_schema().predicates[0].clauses:
        assert holds(clause, invoice.fields.get(clause.field), NOW)


def test_the_same_sentence_read_the_other_way_still_orders_account_first() -> None:
    """"An overdue invoice" takes the invoice as the head noun.

    Its required account does not exist, so one is created — and the edge is the same edge, which
    is why both readings of the sentence produce Account before Invoice.
    """
    outcome = solve(
        [ConstraintPredicate(kind="predicate", name="overdue")],
        schemas=[account_schema(), invoice_schema()],
        records=[],
        utterance="an overdue invoice",
        root=invoice_schema(),
    )
    plan = planned(outcome)

    assert plan.root_node_id == "invoice-1"
    assert plan.graph.materialization_order() == ["account-1", "invoice-1"]


def test_a_predicate_on_an_entity_with_no_path_back_is_refused() -> None:
    unconnected = EntitySchema.model_validate(
        {
            **invoice_schema().model_dump(mode="json", by_alias=True),
            "fields": [
                spec.model_dump(mode="json", by_alias=True)
                for spec in invoice_schema().fields
                if spec.name != "accountId"
            ],
        }
    )
    outcome = solve(
        [ConstraintPredicate(kind="predicate", name="overdue")],
        schemas=[account_schema(), unconnected],
        records=[],
        root=account_schema(),
    )

    assert isinstance(outcome, Refused)
    assert "records no field connecting a Invoice to a Account" in outcome.reason


def test_a_plan_of_one_record_is_still_a_graph() -> None:
    # Building for one record and retrofitting multi-entity later is a rewrite, so the shape is
    # the same even when it holds a single node.
    plan = planned(solve([], records=[], schemas=[order_schema()], root=order_schema()))
    assert plan.graph.materialization_order() == [plan.root_node_id]


# ── Verification: nothing is silently dropped ─────────────────────────────────────────────────


def test_every_constraint_still_holds_on_the_finished_record() -> None:
    constraints: list[Constraint] = [
        equals("status", "pending"),
        equals("terms", "net30"),
        ConstraintCardinality(kind="cardinality", field="lineItems", count=3),
        ConstraintReference(kind="reference", field="accountId", phrase="acme industrial"),
    ]
    node = root_of(solve(constraints))

    assert node.fields["status"] == "pending"
    assert node.fields["terms"] == "net30"
    members = node.fields["lineItems"]
    assert isinstance(members, list)
    assert len(members) == 3
    assert node.fields["accountId"] == "ACC-1001"


def test_a_zero_length_group_is_honoured_exactly() -> None:
    node = root_of(solve([ConstraintCardinality(kind="cardinality", field="lineItems", count=0)]))
    assert node.fields["lineItems"] == []
    assert node.fields["amount"] == 0.0


def test_every_composed_field_carries_an_explanation() -> None:
    """§ 3: "Every field in the plan carries an explanation."

    Any field in the record without one is a value that appeared from nowhere as far as the
    preview is concerned.
    """
    plan = planned(solve([ConstraintPredicate(kind="predicate", name="overdue")]))

    for node in plan.graph.nodes():
        if node.mode is Mode.REUSE_EXISTING:
            continue
        explained = {entry.field for entry in node.provenance}
        assert set(node.fields) <= explained
        assert all(entry.explanation.strip() for entry in node.provenance)
