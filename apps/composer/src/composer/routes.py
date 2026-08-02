"""The composer's HTTP surface: one endpoint, and the two probes every service owes.

`POST /compose` is the whole product surface of this service. It is a *pure function of its
request*: the same body composes the same response, nothing is read from a store, and — the part
worth being loudest about — **nothing is written to the application under test**. Seeding is
action class **S** in CLAUDE.md's taxonomy, which means it is never speculative and never silent;
this endpoint produces the proposal that a human then approves, and the gateway is what acts on it.

## Errors versus outcomes

Two of the three things the composer can conclude are 200s. A conflict and a refusal are answers —
`errors.py` explains why at length — and they come back inside `CompositionResponse` with the
explanation the tester reads. The 4xx and 5xx below are for the cases where the service genuinely
could not do its job: an entity nothing describes, an utterance nothing could be read out of, a
composition that ran past its budget.

## Logging

Every line carries `tenant_id`, `session_id` and `trace_id`, bound for the duration of the request
via `structlog.contextvars` and cleared after — CLAUDE.md § "Conventions". What is deliberately
absent is any field value: a composed record is made of this application's data, and § "PII rule"
governs what may be written down. The log line says how many nodes were planned, not what is in
them.
"""

from __future__ import annotations

import time
from typing import Literal

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from opentelemetry import trace
from pydantic import BaseModel, ConfigDict
from structlog.contextvars import bind_contextvars, clear_contextvars
from structlog.typing import FilteringBoundLogger

from composer.composition import compose
from composer.config import ComposerConfig
from composer.errors import BudgetExceededError, ComposerError, ComposerErrorCode
from composer.logging import get_logger
from composer.protocol.models import CompositionRequest, CompositionResponse
from composer.telemetry import ComposerMetrics, create_metrics, get_tracer

#: Which HTTP status each error code answers with. A typed table rather than a chain of `isinstance`
#: so a new code added to the taxonomy fails to typecheck here until it is given a status.
STATUS_BY_CODE: dict[ComposerErrorCode, int] = {
    "config_invalid": 500,
    "startup_failed": 500,
    "unknown_entity": 422,
    "unparsable_utterance": 422,
    "model_unavailable": 503,
    "budget_exceeded": 504,
    "plan_not_acyclic": 500,
}


class ErrorBody(BaseModel):
    """What a failed request answers with. The code is stable; the message is for a human."""

    model_config = ConfigDict(extra="forbid")

    code: str
    message: str


class HealthBody(BaseModel):
    """Liveness. Touches nothing."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["ok"]


class ReadyBody(BaseModel):
    """Readiness.

    The composer has no dependencies to probe. It holds no database handle, no cache client and no
    queue consumer (docs/ARCHITECTURE.md § 5), and it calls no model provider on the deterministic
    tiers, so a process that is alive is a process that can serve. This is reported honestly rather
    than dressed up with a check of something irrelevant: `dependencies: []` tells whoever is on
    call that there is nothing here to be down, which is exactly the information they need.
    """

    model_config = ConfigDict(extra="forbid")

    status: Literal["ready"]
    dependencies: list[str]


def create_router(config: ComposerConfig, metrics: ComposerMetrics | None = None) -> APIRouter:
    router = APIRouter()
    instruments = metrics if metrics is not None else create_metrics()
    tracer = get_tracer()

    @router.get("/healthz", response_model=HealthBody)
    def healthz() -> HealthBody:
        """Is this process alive? Deliberately checks nothing external.

        A liveness probe that touched a dependency would let a brief blip in that dependency
        convince the orchestrator to restart every replica at once, turning something recoverable
        into an outage.
        """
        return HealthBody(status="ok")

    @router.get("/readyz", response_model=ReadyBody)
    def readyz() -> ReadyBody:
        return ReadyBody(status="ready", dependencies=[])

    @router.post("/compose", response_model=None)
    def compose_route(body: CompositionRequest, request: Request) -> Response:
        started = time.perf_counter()
        span_context = trace.get_current_span().get_span_context()

        bind_contextvars(
            tenant_id=str(body.tenant_id),
            session_id=str(body.session_id),
            trace_id=format(span_context.trace_id, "032x") if span_context.is_valid else None,
        )
        logger = get_logger()

        try:
            with tracer.start_as_current_span("composer.compose") as span:
                span.set_attribute("tenant_id", str(body.tenant_id))
                span.set_attribute("memory_version", str(body.memory_version_id))
                # Class S, always. Recorded on the span so a trace shows at a glance that nothing
                # in it could have mutated the application under test.
                span.set_attribute("action_class", "S")

                response = compose(
                    body, min_confidence=config.compose_min_confidence, metrics=instruments
                )

                span.set_attribute("tier", response.parse_tier.value)
                span.set_attribute("confidence", response.constraint_set.confidence)
                span.set_attribute("outcome", response.outcome.kind)

            _guard_budget(response, config)
            _log_outcome(logger, response)
            return JSONResponse(
                content=response.model_dump(mode="json", by_alias=True), status_code=200
            )

        except ComposerError as error:
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            logger.warning(
                "compose.failed",
                msg=error.message,
                code=error.code,
                duration_ms=round(elapsed_ms, 2),
                route=request.url.path,
            )
            return JSONResponse(
                content=ErrorBody(code=error.code, message=error.message).model_dump(),
                status_code=STATUS_BY_CODE[error.code],
            )
        finally:
            clear_contextvars()

    return router


def _guard_budget(response: CompositionResponse, config: ComposerConfig) -> None:
    """Refuse to hand back a plan that took longer than the budget allows.

    CLAUDE.md § "Performance budgets" puts the seed preview at 1.2 s p95, and `errors.py` explains
    why an over-budget composition is reported rather than returned late: a preview that arrives
    after the tester has moved on makes them decide whether to trust it, which costs more than not
    having it.
    """
    if response.duration_ms > config.compose_budget_ms:
        raise BudgetExceededError(response.duration_ms, config.compose_budget_ms)


def _log_outcome(logger: FilteringBoundLogger, response: CompositionResponse) -> None:
    """One line per composition. Counts and codes only — never a composed value.

    CLAUDE.md § "PII rule" and § "Conventions": a composed record is built from this application's
    own data, and none of it belongs in a log sink. The number of nodes is what tells an operator
    whether the graph came out the size they expected; the values in them tell them nothing they
    need and cannot be unwritten.
    """
    outcome = response.outcome
    fields: dict[str, object] = {
        "outcome": outcome.kind,
        "tier": response.parse_tier.value,
        "duration_ms": round(response.duration_ms, 2),
        "constraints": len(response.constraint_set.constraints),
        "unparsed_fragments": len(response.constraint_set.unparsed_fragments),
        "parse_confidence": response.constraint_set.confidence,
    }
    if outcome.kind == "planned":
        fields["nodes"] = len(outcome.plan.nodes)
        fields["edges"] = len(outcome.plan.edges)
    elif outcome.kind == "refused":
        fields["missing_fields"] = len(outcome.missing_fields)

    logger.info("compose.completed", msg="composition finished", **fields)
