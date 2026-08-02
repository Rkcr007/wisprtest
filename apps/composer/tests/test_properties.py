"""Property-based tests: the two things that must be true of every record the engine composes.

docs/BUILD-PLAN.md Phase 14 asks for exactly this, and names both halves:

    property-based tests with hypothesis that generated records always satisfy their constraint
    set and always validate against their schema

The example-based tests elsewhere in this suite each pin one behaviour against one sentence
somebody chose. These assert the invariants over constraint sets nobody chose, which is the only
way to find the combination that breaks them — a cardinality of zero against a derived sum, a
bound that lands outside the observed range, a predicate colliding with a value drawn three stages
earlier.

## The shape of every property here

    compose it → if it planned, every constraint holds and every record fits its schema

The disjunction matters as much as the assertion. A conflict and a refusal are *answers*
(`errors.py`), so the property is not "always produces a plan" — it is "never produces a plan that
is wrong". An engine that refused everything would pass that, which is why the suite also asserts
separately that the ordinary sentences do plan.

## Independent checking

`satisfies` and `validates` below re-derive what a constraint and a schema mean, rather than
calling the solver's own verification. Reusing the implementation's checker would make these
tests assert only that the solver agrees with itself.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime

from hypothesis import HealthCheck, assume, given, settings
from hypothesis import strategies as st
from support.schemas import account_schema, accounts, invoice_schema, order_schema

from composer.protocol.models import (
    ConstraintCardinality,
    ConstraintComparison,
    ConstraintEquals,
    ConstraintPredicate,
    ConstraintReference,
    EntitySchema,
    FieldSpec,
    FieldType,
    Mode,
    Op,
)
from composer.solving.graph import PlanNode
from composer.solving.predicates import holds
from composer.solving.sampler import ValueSampler
from composer.solving.solver import Conflicted, ConstraintSolver, Refused, Solved
from composer.solving.types import Constraint

NOW = datetime(2026, 8, 1, 9, 0, tzinfo=UTC)
ORDER = order_schema()
ACCOUNT = account_schema()
INVOICE = invoice_schema()

# Hypothesis's own deadline fires on the first, uncached call while the fixture schemas are still
# being validated by pydantic. The work per example is small and bounded; what it is not is
# uniform across the first and the hundredth.
SETTINGS = settings(
    max_examples=150,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)


# ── Independent readings of "satisfies" and "validates" ───────────────────────────────────────


def satisfies(node: PlanNode, constraint: Constraint, schema: EntitySchema) -> bool:
    """Whether one composed record meets one requirement. Written from the contract, not the
    solver — see the module docstring."""
    fields = node.fields

    if isinstance(constraint, ConstraintEquals):
        return fields.get(constraint.field) == constraint.value

    if isinstance(constraint, ConstraintCardinality):
        members = fields.get(constraint.field)
        return isinstance(members, list) and len(members) == constraint.count

    if isinstance(constraint, ConstraintComparison):
        value = fields.get(constraint.field)
        if isinstance(value, bool) or not isinstance(value, int | float):
            return False
        return {
            Op.GT: value > constraint.value,
            Op.GTE: value >= constraint.value,
            Op.LT: value < constraint.value,
            Op.LTE: value <= constraint.value,
        }[constraint.op]

    if isinstance(constraint, ConstraintReference):
        # Either it points at a real record, or the plan creates one and the gateway fills the
        # identifier in from the edge. Both are satisfied; neither is the field being absent.
        return constraint.field in fields

    definition = next(
        (entry for entry in schema.predicates if entry.name == constraint.name), None
    )
    if definition is None:
        return True  # solved on a satellite node, checked there
    return all(holds(clause, fields.get(clause.field), NOW) for clause in definition.clauses)


def validates(node: PlanNode, schema: EntitySchema) -> list[str]:
    """Every way this record would fail its own schema. Empty means it validates."""
    specs = {spec.name: spec for spec in schema.fields}
    problems: list[str] = []

    for name, value in node.fields.items():
        spec = specs.get(name)
        if spec is None:
            problems.append(f"{name} is not a field of {schema.entity_name}")
            continue
        problems.extend(_field_problems(spec, value))

    for spec in schema.fields:
        if spec.required and "." not in spec.name and spec.name not in node.fields:
            problems.append(f"{spec.name} is required and was not filled")

    return problems


def _field_problems(spec: FieldSpec, value: object) -> list[str]:
    if value is None:
        # Only a pending reference may be null: the identifier does not exist yet.
        return [] if spec.references_entity is not None else [f"{spec.name} is null"]

    problems: list[str] = []

    if spec.enum_values is not None and value not in {
        entry.root for entry in spec.enum_values
    }:
        problems.append(f"{spec.name} is {value!r}, outside its learned vocabulary")

    if spec.type in (FieldType.INTEGER, FieldType.NUMBER, FieldType.CURRENCY):
        if isinstance(value, bool) or not isinstance(value, int | float):
            problems.append(f"{spec.name} should be numeric, got {type(value).__name__}")
        elif not math.isfinite(float(value)):
            problems.append(f"{spec.name} is not a finite number")
        elif spec.type is FieldType.INTEGER and not isinstance(value, int):
            problems.append(f"{spec.name} should be a whole number")
    elif spec.type is FieldType.GROUP:
        if not isinstance(value, list):
            problems.append(f"{spec.name} should be a repeated group")
    elif spec.type in (FieldType.DATE, FieldType.DATETIME):
        if not isinstance(value, str):
            problems.append(f"{spec.name} should be a timestamp")
        else:
            try:
                datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                problems.append(f"{spec.name} is not an ISO 8601 timestamp")
    elif spec.type in (FieldType.STRING, FieldType.ENUM, FieldType.REFERENCE):
        if not isinstance(value, str):
            problems.append(f"{spec.name} should be a string")

    limits = spec.value_constraints
    if isinstance(value, int | float) and not isinstance(value, bool):
        if limits.min is not None and value < limits.min:
            problems.append(f"{spec.name} is below the declared minimum")
        if limits.max is not None and value > limits.max:
            problems.append(f"{spec.name} is above the declared maximum")
    if isinstance(value, str):
        if limits.min_length is not None and len(value) < limits.min_length:
            problems.append(f"{spec.name} is shorter than the declared minimum")
        if limits.max_length is not None and len(value) > limits.max_length:
            problems.append(f"{spec.name} is longer than the declared maximum")

    return problems


# ── Strategies ────────────────────────────────────────────────────────────────────────────────


def enum_equals(schema: EntitySchema, field: str) -> st.SearchStrategy[Constraint]:
    spec = next(entry for entry in schema.fields if entry.name == field)
    return st.sampled_from([entry.root for entry in spec.enum_values or []]).map(
        lambda value: ConstraintEquals(kind="equals", field=field, value=value)
    )


ORDER_CONSTRAINTS: st.SearchStrategy[Constraint] = st.one_of(
    enum_equals(ORDER, "status"),
    enum_equals(ORDER, "terms"),
    st.integers(min_value=0, max_value=6).map(
        lambda count: ConstraintCardinality(kind="cardinality", field="lineItems", count=count)
    ),
    st.sampled_from(
        ["acme industrial", "borealis freight", "acme", "somebody nobody has heard of"]
    ).map(lambda phrase: ConstraintReference(kind="reference", field="accountId", phrase=phrase)),
    st.just(ConstraintPredicate(kind="predicate", name="overdue")),
    st.tuples(
        st.sampled_from([Op.GT, Op.GTE, Op.LT, Op.LTE]),
        st.floats(min_value=1.0, max_value=90_000.0, allow_nan=False, allow_infinity=False),
    ).map(
        lambda pair: ConstraintComparison(
            kind="comparison", field="amount", op=pair[0], value=round(pair[1], 2)
        )
    ),
)

INVOICE_CONSTRAINTS: st.SearchStrategy[Constraint] = st.one_of(
    enum_equals(INVOICE, "status"),
    st.just(ConstraintPredicate(kind="predicate", name="overdue")),
    st.tuples(
        st.sampled_from([Op.GT, Op.GTE, Op.LT, Op.LTE]),
        st.floats(min_value=1.0, max_value=60_000.0, allow_nan=False, allow_infinity=False),
    ).map(
        lambda pair: ConstraintComparison(
            kind="comparison", field="total", op=pair[0], value=round(pair[1], 2)
        )
    ),
)

UTTERANCES = st.sampled_from(
    ["an order", "a new order", "an order for acme industrial", "a new order for a new account"]
)


def compose(
    schema: EntitySchema,
    constraints: list[Constraint],
    *,
    seed: int,
    utterance: str = "an order",
    schemas: list[EntitySchema] | None = None,
) -> Solved | Conflicted | Refused:
    solver = ConstraintSolver(
        schemas=schemas if schemas is not None else [ORDER, ACCOUNT, INVOICE],
        existing_records=accounts(),
        utterance=utterance,
        now=NOW,
        sampler=ValueSampler(now=NOW, seed=seed),
        parse_confidence=0.9,
    )
    return solver.solve(schema, constraints)


# ── The properties ────────────────────────────────────────────────────────────────────────────


@SETTINGS
@given(
    constraints=st.lists(ORDER_CONSTRAINTS, min_size=0, max_size=4),
    seed=st.integers(min_value=0, max_value=2**32),
    utterance=UTTERANCES,
)
def test_a_planned_order_satisfies_every_constraint_it_was_given(
    constraints: list[Constraint], seed: int, utterance: str
) -> None:
    """§ 7: "never silently drop a constraint", asserted over sets nobody chose.

    A dropped constraint is the worst failure this engine has, because the tester gets a record,
    has no reason to doubt it, and tests something other than what they meant to.
    """
    outcome = compose(ORDER, constraints, seed=seed, utterance=utterance)
    if not isinstance(outcome, Solved):
        return

    root = outcome.graph.node(outcome.root_node_id)
    for constraint in constraints:
        assert satisfies(root, constraint, ORDER), (constraint, root.fields)


@SETTINGS
@given(
    constraints=st.lists(ORDER_CONSTRAINTS, min_size=0, max_size=4),
    seed=st.integers(min_value=0, max_value=2**32),
    utterance=UTTERANCES,
)
def test_every_record_in_a_planned_order_validates_against_its_own_schema(
    constraints: list[Constraint], seed: int, utterance: str
) -> None:
    """A record the application would reject is worse than no record.

    It passes creation or it does not, and either way the tester spends an afternoon deciding
    whether they found a bug. Every node is checked, not only the one that was asked for.
    """
    outcome = compose(ORDER, constraints, seed=seed, utterance=utterance)
    if not isinstance(outcome, Solved):
        return

    for node in outcome.graph.nodes():
        if node.mode is Mode.REUSE_EXISTING:
            continue
        assert validates(node, node.schema) == [], (node.node_id, node.fields)


@SETTINGS
@given(
    constraints=st.lists(INVOICE_CONSTRAINTS, min_size=0, max_size=3),
    seed=st.integers(min_value=0, max_value=2**32),
)
def test_the_same_two_properties_hold_for_a_different_entity(
    constraints: list[Constraint], seed: int
) -> None:
    """The engine is generic or it is not.

    `Invoice` differs from `Order` in every way that matters here — its numeric field is not
    derived, its predicate spans a different vocabulary, and its reference is required with no
    phrase to resolve it — so the same properties holding over both is the evidence that nothing
    was written around the first fixture.
    """
    outcome = compose(INVOICE, constraints, seed=seed, utterance="an invoice")
    if not isinstance(outcome, Solved):
        return

    root = outcome.graph.node(outcome.root_node_id)
    for constraint in constraints:
        assert satisfies(root, constraint, INVOICE), (constraint, root.fields)
    for node in outcome.graph.nodes():
        if node.mode is not Mode.REUSE_EXISTING:
            assert validates(node, node.schema) == [], (node.node_id, node.fields)


@SETTINGS
@given(
    constraints=st.lists(ORDER_CONSTRAINTS, min_size=0, max_size=4),
    seed=st.integers(min_value=0, max_value=2**32),
)
def test_a_plan_is_always_orderable_and_rooted(
    constraints: list[Constraint], seed: int
) -> None:
    """`materializationOrder` is executed literally against a live application.

    Every node appears exactly once, dependencies come before the records that need them, and the
    root is one of the nodes. An order that ignored a dependency would create records pointing at
    identifiers that do not exist yet.
    """
    outcome = compose(ORDER, constraints, seed=seed)
    if not isinstance(outcome, Solved):
        return

    order = outcome.graph.materialization_order()
    node_ids = [node.node_id for node in outcome.graph.nodes()]

    assert sorted(order) == sorted(node_ids)
    assert outcome.root_node_id in order
    for edge in outcome.graph.edges():
        assert order.index(edge.to_node_id) < order.index(edge.from_node_id)


@SETTINGS
@given(
    constraints=st.lists(ORDER_CONSTRAINTS, min_size=0, max_size=4),
    seed=st.integers(min_value=0, max_value=2**32),
)
def test_every_created_field_carries_an_explanation(
    constraints: list[Constraint], seed: int
) -> None:
    """§ 3: "Every field in the plan carries an explanation."

    A field without one is a value that appeared from nowhere as far as the preview is concerned,
    and the preview is the whole reason seeding is trustworthy rather than spooky.
    """
    outcome = compose(ORDER, constraints, seed=seed)
    if not isinstance(outcome, Solved):
        return

    for node in outcome.graph.nodes():
        if node.mode is Mode.REUSE_EXISTING:
            continue
        explained = {entry.field for entry in node.provenance}
        assert set(node.fields) <= explained, (node.node_id, set(node.fields) - explained)
        assert all(entry.explanation.strip() for entry in node.provenance)
        assert all(0.0 <= entry.confidence <= 1.0 for entry in node.provenance)


@SETTINGS
@given(
    constraints=st.lists(ORDER_CONSTRAINTS, min_size=0, max_size=4),
    seed=st.integers(min_value=0, max_value=2**32),
)
def test_the_same_seed_composes_the_same_plan_twice(
    constraints: list[Constraint], seed: int
) -> None:
    """`CompositionRequest.seed` exists to make this true.

    Sampling is the only nondeterminism in the composer, and without this the preview a tester
    approved and the record the gateway creates could differ.
    """
    first = compose(ORDER, constraints, seed=seed)
    second = compose(ORDER, constraints, seed=seed)

    assert type(first) is type(second)
    if isinstance(first, Solved) and isinstance(second, Solved):
        assert [node.fields for node in first.graph.nodes()] == [
            node.fields for node in second.graph.nodes()
        ]


@SETTINGS
@given(
    constraints=st.lists(ORDER_CONSTRAINTS, min_size=1, max_size=4),
    seed=st.integers(min_value=0, max_value=2**32),
)
def test_a_refusal_or_a_conflict_always_says_something_specific(
    constraints: list[Constraint], seed: int
) -> None:
    """Neither answer is allowed to be a shrug.

    § 7 requires a conflict to "report the conflict in plain language" and a refusal to name "the
    specific missing field". An outcome a tester cannot act on is barely better than no outcome.
    """
    outcome = compose(ORDER, constraints, seed=seed)

    if isinstance(outcome, Conflicted):
        assert outcome.conflict.explanation.strip()
        assert len(outcome.conflict.explanation) > 20
    elif isinstance(outcome, Refused):
        assert outcome.reason.strip()
        assert outcome.entity


@SETTINGS
@given(
    count=st.integers(min_value=0, max_value=6),
    seed=st.integers(min_value=0, max_value=2**32),
)
def test_a_derived_total_always_equals_what_the_application_would_compute(
    count: int, seed: int
) -> None:
    """The reason derived rules are evaluated last.

    `amount` is the sum of the line items, so a record whose total does not match its own lines is
    one the application will disagree with the moment it is created — and the preview would have
    shown the tester a number the record does not have.
    """
    outcome = compose(
        ORDER, [ConstraintCardinality(kind="cardinality", field="lineItems", count=count)], seed=seed
    )
    if not isinstance(outcome, Solved):
        return

    root = outcome.graph.node(outcome.root_node_id)
    members = root.fields["lineItems"]
    assert isinstance(members, list)
    assert len(members) == count
    assert root.fields["amount"] == round(sum(float(row["amount"]) for row in members), 2)


@SETTINGS
@given(
    op=st.sampled_from([Op.GT, Op.GTE]),
    target=st.floats(min_value=100.0, max_value=80_000.0, allow_nan=False, allow_infinity=False),
    seed=st.integers(min_value=0, max_value=2**32),
)
def test_a_bound_on_a_computed_total_is_reached_through_the_lines(
    op: Op, target: float, seed: int
) -> None:
    """"An order over £50,000" when the application computes the total from the lines.

    Two things have to be true at once and it is easy to get only one: the total satisfies the
    bound, *and* it is still the sum of the lines. Satisfying the bound by writing a number into
    the total would be overwritten by the application on creation.
    """
    bound = ConstraintComparison(kind="comparison", field="amount", op=op, value=round(target, 2))
    outcome = compose(ORDER, [bound], seed=seed)
    assume(isinstance(outcome, Solved))
    assert isinstance(outcome, Solved)

    root = outcome.graph.node(outcome.root_node_id)
    total = root.fields["amount"]
    members = root.fields["lineItems"]

    assert isinstance(total, float) and isinstance(members, list)
    assert satisfies(root, bound, ORDER)
    assert total == round(sum(float(row["amount"]) for row in members), 2)


@SETTINGS
@given(seed=st.integers(min_value=0, max_value=2**32))
def test_the_worked_example_always_orders_account_before_invoice(seed: int) -> None:
    """docs/TEST-DATA-ENGINE.md § 3's worked example, over every seed rather than one.

    The ordering is the part that cannot be allowed to depend on which values were drawn: an
    invoice created before the account it points at references an identifier that does not exist.
    """
    outcome = compose(
        ACCOUNT,
        [ConstraintPredicate(kind="predicate", name="overdue")],
        seed=seed,
        utterance="an account with an overdue invoice",
        schemas=[ACCOUNT, INVOICE],
    )
    assert isinstance(outcome, Solved)

    order = outcome.graph.materialization_order()
    assert order == ["account-1", "invoice-1"]
    assert outcome.root_node_id == "account-1"

    invoice = outcome.graph.node("invoice-1")
    for clause in INVOICE.predicates[0].clauses:
        assert holds(clause, invoice.fields.get(clause.field), NOW)
