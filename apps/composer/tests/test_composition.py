"""The pipeline end to end: one utterance in, one `CompositionResponse` out.

Every module below `compose` has its own suite. This one asserts the thing none of them can: that
they are wired in the order docs/TEST-DATA-ENGINE.md § 3 specifies, and that each of the three
things the composer can conclude — a plan, a conflict, a refusal — comes back shaped the way the
gateway will read it.

Two properties get particular attention because they are load-bearing elsewhere:

* **Order of the gates.** § 7 puts the confidence check and the stated-contradiction check *in
  front of* the solver. A refusal that arrives after a plan was half-built is the same answer at a
  worse price, and a conflict found by the solver rather than by inspection is one the tester
  waited for.
* **Reproducibility.** `CompositionRequest.seed` exists so sampling repeats. That is worth nothing
  if the plan identifier is drawn fresh, so it is derived from the request and asserted here.
"""

from __future__ import annotations

import time
from typing import Any

import pytest
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from composer.composition import compose
from composer.errors import UnknownEntityError, UnparsableUtteranceError
from composer.protocol.models import (
    CompositionConflicted,
    CompositionPlanned,
    CompositionRefused,
    CompositionRequest,
    CompositionResponse,
    EntitySchema,
    Mode,
    ParseTier,
)
from composer.telemetry import ComposerMetrics, create_metrics
from support.schemas import account_schema, invoice_schema, order_schema, request_body

MIN_CONFIDENCE = 0.5

#: The worked example from docs/TEST-DATA-ENGINE.md § 3, verbatim.
WORKED_EXAMPLE = "i need a pending order for acme industrial with three line items"


def request(utterance: str, **overrides: Any) -> CompositionRequest:  # noqa: ANN401
    """A real `CompositionRequest`, built from the contract's own JSON shape."""
    overrides.setdefault("schemas", [order_schema(), account_schema(), invoice_schema()])
    return CompositionRequest.model_validate(request_body(utterance, **overrides))


def composed(utterance: str, **overrides: Any) -> CompositionResponse:  # noqa: ANN401
    return compose(request(utterance, **overrides), min_confidence=MIN_CONFIDENCE)


def planned(response: CompositionResponse) -> CompositionPlanned:
    assert isinstance(response.outcome, CompositionPlanned), response.outcome
    return response.outcome


def thinned(**overrides: Any) -> EntitySchema:  # noqa: ANN401
    """An `Order` the indexer learned less about than it needs to compose one.

    Built by taking the real fixture apart rather than by writing a second one, so what it proves
    is about the fields that changed and not about a schema shaped to give the answer.
    """
    raw = order_schema().model_dump(mode="json", by_alias=True)
    raw.update(overrides)
    return EntitySchema.model_validate(raw)


# ── A plan ────────────────────────────────────────────────────────────────────────────────────


def test_the_worked_example_composes_an_account_then_an_order() -> None:
    """§ 3's sentence, through every stage. Two records, in the only order that can be created."""
    response = composed(WORKED_EXAMPLE)
    outcome = planned(response)

    entities = {node.node_id: node.entity for node in outcome.plan.nodes}
    order = [entry.root for entry in outcome.plan.materialization_order]

    assert sorted(entities.values()) == ["Account", "Order"]
    assert entities[outcome.plan.root_node_id] == "Order"
    # The account is reused, not invented: the request carried it, and creating a second Acme
    # would leave a duplicate behind that changes what the test covered.
    reused = [node for node in outcome.plan.nodes if node.mode is Mode.REUSE_EXISTING]
    assert [node.entity for node in reused] == ["Account"]
    # The order points at the account, so the account has to exist first.
    assert [edge.via_field for edge in outcome.plan.edges] == ["accountId"]
    assert order.index(reused[0].node_id) < order.index(outcome.plan.root_node_id)


def test_the_plan_carries_the_request_s_own_identifiers() -> None:
    """The gateway matches an approved plan back to the session that asked for it."""
    body = request(WORKED_EXAMPLE)
    outcome = planned(compose(body, min_confidence=MIN_CONFIDENCE))

    assert outcome.plan.tenant_id == body.tenant_id
    assert outcome.plan.session_id == body.session_id
    assert outcome.plan.memory_version_id == body.memory_version_id
    assert outcome.plan.created_at == body.now


def test_the_constraint_set_comes_back_beside_the_plan() -> None:
    """The preview shows what was understood, not only what was produced.

    A tester reading a record they did not expect needs to see which requirement produced it, and
    the same set is on the response and on the plan so neither half can be read without the other.
    """
    response = composed(WORKED_EXAMPLE)
    outcome = planned(response)

    assert response.parse_tier is ParseTier.T0
    assert response.constraint_set.unparsed_fragments == []
    assert len(response.constraint_set.constraints) == 3
    assert outcome.plan.constraint_set == response.constraint_set


def test_a_deterministic_parse_learns_nothing_and_writes_no_alias_back() -> None:
    """The write-back loop belongs to escalation.

    An alias is learned when a model reads a phrasing the deterministic tiers could not. Every
    parse that reaches a plan at T0 was already understood, so writing one back would grow the
    corpus with phrasings it already contains.
    """
    assert planned(composed(WORKED_EXAMPLE)).alias_write_backs == []


# ── Reproducibility ───────────────────────────────────────────────────────────────────────────


def test_the_same_request_composes_a_byte_identical_response() -> None:
    body = request(WORKED_EXAMPLE)

    first = compose(body, min_confidence=MIN_CONFIDENCE)
    second = compose(body, min_confidence=MIN_CONFIDENCE)

    # Everything but the duration, which measures wall clock and is expected to differ.
    assert first.model_dump(mode="json", exclude={"duration_ms"}) == second.model_dump(
        mode="json", exclude={"duration_ms"}
    )


def test_a_different_seed_is_a_different_plan_and_says_so_in_its_id() -> None:
    """A plan id drawn fresh would make every response non-reproducible as a whole.

    Derived from the request instead — which means two requests that differ anywhere the sampling
    depends on must derive different ids, or a cache keyed on the id would serve one for the other.
    """
    first = planned(composed(WORKED_EXAMPLE, seed=7)).plan
    second = planned(composed(WORKED_EXAMPLE, seed=8)).plan

    assert first.id != second.id
    assert planned(composed(WORKED_EXAMPLE, seed=7)).plan.id == first.id


@pytest.mark.parametrize("field", ["utterance", "route", "now"])
def test_every_input_the_plan_depends_on_changes_its_id(field: str) -> None:
    baseline = planned(composed("a pending order")).plan.id

    changed = {
        "utterance": lambda: composed("an approved order"),
        "route": lambda: composed("a pending order", route="/orders/open"),
        "now": lambda: composed("a pending order", now="2026-08-02T09:00:00Z"),
    }[field]()

    if field == "route":
        # The route scopes which entity the utterance is about; it is not part of the derivation,
        # and the same sentence on a route that resolves to the same entity is the same plan.
        assert planned(changed).plan.id == baseline
    else:
        assert planned(changed).plan.id != baseline


# ── Refusals: the schema is too thin to compose from ───────────────────────────────────────────


def test_a_schema_below_the_threshold_is_refused_before_any_value_is_drawn() -> None:
    """§ 7's first gate. The numbers are in the sentence because a bare "too uncertain" is not
    something a QA lead can act on."""
    response = composed("a pending order", schemas=[thinned(confidence=0.31), account_schema()])
    outcome = response.outcome

    assert isinstance(outcome, CompositionRefused), outcome
    assert outcome.entity == "Order"
    assert "0.31" in outcome.reason
    assert "0.50" in outcome.reason
    # The constraint set is still returned: the tester should see that the sentence was understood
    # and that the schema, not their phrasing, is what stopped it.
    assert len(response.constraint_set.constraints) == 1


def test_the_refusal_names_only_the_fields_nobody_has_ever_seen_a_value_for() -> None:
    """ "There are required fields nobody has seen a value for, and here they are."

    Four of this schema's fields are required or otherwise fillable and are deliberately *not*
    listed, each for a different reason — a derived rule computes one, a reference resolves one,
    a learned vocabulary supplies one, and a group member cannot be filled on its own. Listing any
    of them would send somebody to index a form that would not help.
    """
    raw = order_schema().model_dump(mode="json", by_alias=True)
    for spec in raw["fields"]:
        if spec["name"] in ("customer", "lineItems.amount"):
            spec["distribution"] = None
            spec["required"] = True

    outcome = composed(
        "a pending order",
        schemas=[EntitySchema.model_validate({**raw, "confidence": 0.31}), account_schema()],
    ).outcome

    assert isinstance(outcome, CompositionRefused), outcome
    assert [entry.root for entry in outcome.missing_fields] == ["customer"]


def test_a_reference_that_can_be_neither_matched_nor_created_is_refused_by_the_solver() -> None:
    """The second kind of refusal: the schema was confident enough, the record still cannot exist.

    It comes back as the same outcome type as the confidence refusal, carrying the solver's own
    explanation rather than one written here.
    """
    outcome = composed("an order for acme", schemas=[order_schema()], records=[]).outcome

    assert isinstance(outcome, CompositionRefused), outcome
    assert [entry.root for entry in outcome.missing_fields] == ["accountId"]
    assert "Account" in outcome.reason


# ── Conflicts: both gates report through the same type ─────────────────────────────────────────


def test_two_things_the_tester_said_that_cannot_both_hold_are_caught_by_inspection() -> None:
    """ "over 50,000 and under 1,000" needs no solver run to be known impossible."""
    response = composed("an order over 50000 and under 1000")
    outcome = response.outcome

    assert isinstance(outcome, CompositionConflicted), outcome
    assert outcome.conflict.field == "amount"
    assert "50,000" in outcome.conflict.explanation
    assert "1,000" in outcome.conflict.explanation
    # Both comparisons are still reported. § 7: never silently drop a constraint.
    assert len(response.constraint_set.constraints) == 2


def test_a_contradiction_only_the_solver_can_see_is_reported_through_the_same_type() -> None:
    """A bound on a field the application stores as an enum. Nothing about the two constraints
    contradicts; it is the schema that makes the sentence impossible, which is the solver's to
    find."""
    outcome = composed("an order with terms over 5").outcome

    assert isinstance(outcome, CompositionConflicted), outcome
    assert outcome.conflict.field == "terms"
    assert "enum" in outcome.conflict.explanation


# ── The two things that are errors rather than answers ─────────────────────────────────────────


def test_an_entity_no_schema_describes_names_what_the_memory_version_does_know() -> None:
    """Distinct from a refusal, and a different fix: index the application, or index more of it."""
    with pytest.raises(UnknownEntityError) as raised:
        composed("i need a widget", schemas=[order_schema(), account_schema()], route="/home")

    assert raised.value.code == "unknown_entity"
    assert raised.value.known == ["Order", "Account"]


def test_an_utterance_no_tier_could_read_is_an_error_rather_than_an_empty_plan() -> None:
    """Composing from zero constraints would produce a record nobody asked for."""
    with pytest.raises(UnparsableUtteranceError) as raised:
        composed("an escalated order")

    assert raised.value.code == "unparsable_utterance"
    # The message deliberately does not quote the utterance back: § "PII rule". It is spoken in
    # the tester's own words about the application's own data, and it goes into a log line.
    assert "escalated" not in raised.value.message


# ── Measurement ───────────────────────────────────────────────────────────────────────────────


def instruments() -> tuple[ComposerMetrics, InMemoryMetricReader]:
    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader])
    return create_metrics(provider.get_meter("test")), reader


def points(reader: InMemoryMetricReader, name: str) -> list[Any]:
    data = reader.get_metrics_data()
    assert data is not None
    return [
        point
        for resource in data.resource_metrics
        for scope in resource.scope_metrics
        for metric in scope.metrics
        if metric.name == name
        for point in metric.data.data_points
    ]


def test_every_outcome_is_measured_not_only_the_ones_that_produced_a_plan() -> None:
    """A refusal that took four seconds still cost the tester four seconds.

    A latency histogram that counts only successes hides exactly the cases worth looking at, so
    all three outcomes are recorded and each carries the label that says which it was.
    """
    metrics, reader = instruments()

    for utterance in (
        WORKED_EXAMPLE,
        "an order over 50000 and under 1000",
        "an order for acme",
    ):
        schemas = (
            [order_schema()]
            if utterance == "an order for acme"
            else [order_schema(), account_schema(), invoice_schema()]
        )
        records = [] if utterance == "an order for acme" else None
        compose(
            request(utterance, schemas=schemas, records=records),
            min_confidence=MIN_CONFIDENCE,
            metrics=metrics,
        )

    latency = points(reader, "wispr_seed_plan_latency_ms")
    assert sum(point.count for point in latency) == 3
    assert {point.attributes["outcome"] for point in latency} == {
        "planned",
        "conflict",
        "refused",
    }
    assert all(point.sum > 0 for point in latency)

    outcomes = points(reader, "wispr_compose_outcome_total")
    assert {point.attributes["outcome"]: point.value for point in outcomes} == {
        "planned": 1,
        "conflict": 1,
        "refused": 1,
    }

    tiers = points(reader, "wispr_tier_total")
    assert {point.attributes["tier"]: point.value for point in tiers} == {"T0": 3}


def test_the_reported_duration_is_the_time_the_composition_actually_took() -> None:
    """Not a placeholder and not the request's own clock: `_guard_budget` refuses on this number,
    so a duration that did not measure anything would be a budget nobody was held to."""
    body = request(WORKED_EXAMPLE)

    before = time.perf_counter()
    response = compose(body, min_confidence=MIN_CONFIDENCE)
    wall_ms = (time.perf_counter() - before) * 1000.0

    assert 0.0 < response.duration_ms <= wall_ms


def test_composing_without_instruments_answers_exactly_the_same() -> None:
    """Metrics are optional to pass and never change the answer."""
    metrics, _ = instruments()
    body = request(WORKED_EXAMPLE)

    with_metrics = compose(body, min_confidence=MIN_CONFIDENCE, metrics=metrics)
    without = compose(body, min_confidence=MIN_CONFIDENCE, metrics=None)

    assert with_metrics.model_dump(mode="json", exclude={"duration_ms"}) == without.model_dump(
        mode="json", exclude={"duration_ms"}
    )
