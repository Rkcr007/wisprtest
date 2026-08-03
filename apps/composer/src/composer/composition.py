"""One utterance in, one `CompositionResponse` out.

This is the whole composer in one function, and the shape of it is the pipeline in
docs/TEST-DATA-ENGINE.md § 3:

    ConstraintParser → SchemaLoad → ConstraintSolver → ProvenanceBuilder → CompositionPlan

with two gates in front of the solver that § 7 requires and that are cheaper to check than to
discover: a schema too uncertain to compose from is refused before any value is drawn, and a
constraint set that contradicts itself is reported before the solver spends time satisfying half
of it.

## Nothing here writes anything

`apps/composer` is stateless (docs/ARCHITECTURE.md § 5) and composing is a proposal, not an
action. Everything reasoned over arrives in the request; everything concluded leaves in the
response; no database handle exists in this process to write to even by accident. The plan is
rendered to a human and only an explicit approval sends it to the gateway to materialize, which is
what makes seeding a class **S** action rather than a class **C** one.

## Reproducibility

The plan identifier is derived from the request rather than drawn fresh, so composing the same
request twice — same tenant, session, utterance, clock and seed — produces a byte-identical
response. `CompositionRequest.seed` exists to make sampling reproducible, and a random plan id
would have left the response as a whole non-reproducible anyway.
"""

from __future__ import annotations

import time
from uuid import NAMESPACE_URL, UUID, uuid5

from composer.errors import UnknownEntityError, UnparsableUtteranceError
from composer.parsing.parser import ConstraintParser, choose_entity
from composer.protocol.models import (
    CompositionConflicted,
    CompositionPlan,
    CompositionPlanned,
    CompositionRefused,
    CompositionRequest,
    CompositionResponse,
    ConstraintSet,
    EntitySchema,
    FieldSpec,
    NonEmptyStringModel,
    ParseTier,
)
from composer.solving.conflicts import find_conflict
from composer.solving.sampler import ValueSampler
from composer.solving.solver import Conflicted, ConstraintSolver, Refused, Solved
from composer.telemetry import ComposerMetrics

#: Namespace for deterministic plan identifiers. A fixed UUID, so the derivation is stable across
#: processes and releases; regenerating it would change every plan id for the same request.
PLAN_NAMESPACE = uuid5(NAMESPACE_URL, "https://wisprtest.dev/composition-plan")


def compose(
    request: CompositionRequest,
    *,
    min_confidence: float,
    metrics: ComposerMetrics | None = None,
) -> CompositionResponse:
    """Read the utterance, solve it, and answer with a plan, a conflict or a refusal."""
    started = time.perf_counter()

    schema = choose_entity(request.utterance, request.schemas, request.runtime_state.route_pattern)
    if schema is None:
        raise UnknownEntityError(
            request.utterance, [entry.entity_name for entry in request.schemas]
        )

    parsed = ConstraintParser(schema, request.aliases, request.schemas).parse(request.utterance)
    constraint_set = parsed.constraint_set
    tier = ParseTier(parsed.tier)

    if not constraint_set.constraints:
        raise UnparsableUtteranceError(request.utterance)

    outcome: CompositionPlanned | CompositionConflicted | CompositionRefused

    if schema.confidence < min_confidence:
        outcome = CompositionRefused(
            kind="refused",
            constraint_set=constraint_set,
            entity=schema.entity_name,
            missing_fields=[
                NonEmptyStringModel(root=spec.name) for spec in _unlearned_fields(schema)
            ],
            reason=(
                f"what is known about a {schema.entity_name} in this application scores "
                f"{schema.confidence:.2f}, below the {min_confidence:.2f} needed to compose "
                "one; indexing the create form would fix it"
            ),
        )
        return _respond(request, constraint_set, outcome, tier, started, metrics)

    stated = find_conflict(schema, list(constraint_set.constraints))
    if stated is not None:
        outcome = CompositionConflicted(
            kind="conflict", constraint_set=constraint_set, conflict=stated
        )
        return _respond(request, constraint_set, outcome, tier, started, metrics)

    solver = ConstraintSolver(
        schemas=request.schemas,
        existing_records=request.existing_records,
        utterance=request.utterance,
        now=request.now,
        sampler=ValueSampler(now=request.now, seed=request.seed),
        parse_confidence=constraint_set.confidence,
    )
    solved = solver.solve(schema, list(constraint_set.constraints))

    if isinstance(solved, Conflicted):
        outcome = CompositionConflicted(
            kind="conflict", constraint_set=constraint_set, conflict=solved.conflict
        )
    elif isinstance(solved, Refused):
        outcome = CompositionRefused(
            kind="refused",
            constraint_set=constraint_set,
            entity=solved.entity,
            missing_fields=[NonEmptyStringModel(root=name) for name in solved.missing_fields],
            reason=solved.reason,
        )
    else:
        outcome = CompositionPlanned(
            kind="planned",
            plan=_plan(request, constraint_set, solved),
            # Empty until an escalation tier writes one: an alias is learned when a model reads a
            # phrasing the deterministic tiers could not, and every parse that gets this far was
            # read at T0 or T1, which by definition learned nothing new.
            alias_write_backs=[],
        )

    return _respond(request, constraint_set, outcome, tier, started, metrics)


def _plan(
    request: CompositionRequest,
    constraint_set: ConstraintSet,
    solved: Solved,
) -> CompositionPlan:
    graph = solved.graph
    return CompositionPlan(
        id=_plan_id(request),
        tenant_id=request.tenant_id,
        session_id=request.session_id,
        memory_version_id=request.memory_version_id,
        root_node_id=solved.root_node_id,
        nodes=[node.to_model() for node in graph.nodes()],
        edges=graph.edges(),
        materialization_order=[
            NonEmptyStringModel(root=node_id) for node_id in graph.materialization_order()
        ],
        constraint_set=constraint_set,
        created_at=request.now,
    )


def _plan_id(request: CompositionRequest) -> UUID:
    """A plan identifier that is a function of the request, so the same request plans the same."""
    return uuid5(
        PLAN_NAMESPACE,
        "|".join(
            [
                str(request.tenant_id),
                str(request.session_id),
                str(request.memory_version_id),
                request.utterance,
                request.now.isoformat(),
                str(request.seed),
            ]
        ),
    )


def _unlearned_fields(schema: EntitySchema) -> list[FieldSpec]:
    """Required fields the indexer learned nothing usable about.

    § 7: "Schema confidence too low to compose → refuse with the specific missing field". The
    specificity is the point. "This schema is 0.31 confident" tells a QA lead nothing they can
    act on; "there are three required fields nobody has ever seen a value for, and here they
    are" tells them exactly which form to index.
    """
    return [
        spec
        for spec in schema.fields
        if spec.required
        and "." not in spec.name
        and spec.derived_rule is None
        and spec.references_entity is None
        and not spec.enum_values
        and spec.distribution is None
    ]


def _respond(
    request: CompositionRequest,
    constraint_set: ConstraintSet,
    outcome: CompositionPlanned | CompositionConflicted | CompositionRefused,
    tier: ParseTier,
    started: float,
    metrics: ComposerMetrics | None,
) -> CompositionResponse:
    duration_ms = (time.perf_counter() - started) * 1000.0

    if metrics is not None:
        # Latency is recorded on every path, not only the ones that produced a plan. A refusal
        # that took four seconds still cost the tester four seconds, and a histogram that counts
        # only successes hides exactly the cases worth looking at.
        metrics.seed_plan_latency_ms.record(duration_ms, {"outcome": outcome.kind})
        metrics.tier_total.add(1, {"tier": tier.value})
        metrics.compose_outcome_total.add(1, {"outcome": outcome.kind})

    return CompositionResponse(
        constraint_set=constraint_set,
        outcome=outcome,
        parse_tier=tier,
        duration_ms=duration_ms,
    )
