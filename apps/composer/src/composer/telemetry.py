"""Tracing and metrics.

CLAUDE.md rule #6 makes this part of the phase's definition of done rather than a follow-up, and
docs/ARCHITECTURE.md § 7 names the instruments. Three of them belong to this process, because it
is the only one that knows their values:

| Metric                          | Recorded when                                            |
|---------------------------------|----------------------------------------------------------|
| `wispr_seed_plan_latency_ms`    | every `POST /compose`, whatever it concluded             |
| `wispr_tier_total{tier}`        | every parse, labelled with the tier that read it         |
| `wispr_compose_outcome_total`   | every composition, labelled `planned`/`conflict`/`refused` |

`wispr_seed_plan_latency_ms` is the one CLAUDE.md § "Performance budgets" gates: the seed preview
is budgeted at 1.2 s p95, and this histogram is where that number is read from. It is recorded on
the conflict and refusal paths too — a refusal that takes four seconds has still cost the tester
four seconds, and a latency metric that only counts successes hides exactly the cases worth seeing.

`wispr_compose_outcome_total` is not in § 7. It is here because the ratio between the three
outcomes is the health signal for the whole engine: a rising refusal rate means an application
whose schemas are drifting out of confidence, and a rising conflict rate means the parser is
reading utterances in ways testers do not mean. Neither is visible from latency.

## Why the exporter is optional and the service name is not read from the environment

`OTEL_EXPORTER_OTLP_ENDPOINT` is optional for the same reason it is optional in the gateway:
without a collector the SDK still creates spans and records measurements, it just does not ship
them, and a developer running `make dev` should not see an export failure on every request. This
is not the defaulting CLAUDE.md rule #10 forbids — that rule is about config the service cannot
run correctly without, and there is no correct value to guess for a collector that is not there.

The service name is a constant rather than an environment variable because `.env.example` already
records why: "a single .env cannot hold two values for one key, and every service needs its own
service name". The indexer sets its own in its start script; the composer sets its own here.
"""

from __future__ import annotations

from dataclasses import dataclass

from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.metrics import Counter, Histogram, Meter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import Tracer

#: Service name on every span and metric this process emits.
SERVICE_NAME = "wispr-composer"

#: Instrumentation scope. Matches the gateway's `wispr.gateway` convention.
METER_NAME = "wispr.composer"
TRACER_NAME = "wispr.composer"


@dataclass(frozen=True)
class ComposerMetrics:
    """The instruments this service owns."""

    #: Time to compose a plan, in milliseconds. Budgeted at 1.2 s p95.
    seed_plan_latency_ms: Histogram
    #: Parses, labelled by the tier that read the utterance. The compounding-loop health metric.
    tier_total: Counter
    #: Compositions, labelled by outcome. Refusal and conflict rates are schema-quality signals.
    compose_outcome_total: Counter


def create_metrics(meter: Meter | None = None) -> ComposerMetrics:
    """Build the instruments against `meter`, or against the globally configured provider."""
    resolved = meter if meter is not None else metrics.get_meter(METER_NAME)
    return ComposerMetrics(
        seed_plan_latency_ms=resolved.create_histogram(
            "wispr_seed_plan_latency_ms",
            unit="ms",
            description="Time to compose a CompositionPlan, in milliseconds.",
        ),
        tier_total=resolved.create_counter(
            "wispr_tier_total",
            description="Utterances parsed, labelled by the tier that read them.",
        ),
        compose_outcome_total=resolved.create_counter(
            "wispr_compose_outcome_total",
            description="Compositions, labelled by outcome: planned, conflict or refused.",
        ),
    )


def get_tracer() -> Tracer:
    return trace.get_tracer(TRACER_NAME)


@dataclass(frozen=True)
class Telemetry:
    """A configured SDK, and the handle that flushes it on shutdown."""

    #: Whether spans and measurements are leaving the process. Reported in the startup line.
    exporting: bool
    _tracer_provider: TracerProvider
    _meter_provider: MeterProvider

    def shutdown(self) -> None:
        """Flush and stop. Called from the lifespan so in-flight spans are not lost on SIGTERM."""
        self._tracer_provider.shutdown()
        self._meter_provider.shutdown()


def start_telemetry(*, env: str, endpoint: str | None, version: str = "0.0.0") -> Telemetry:
    """Install the tracer and meter providers globally.

    Returns a handle rather than nothing so the application lifespan can flush on shutdown. An
    unflushed batch processor drops whatever it was holding when the process exits, which loses
    precisely the spans from the request that was in flight when something went wrong.

    Installing a second time in one process reuses what is already installed. The OTel API refuses
    to replace a configured provider and logs a warning for every attempt, and a test suite that
    builds several applications would otherwise spend its output on that warning.
    """
    installed_tracer = trace.get_tracer_provider()
    installed_meter = metrics.get_meter_provider()
    if isinstance(installed_tracer, TracerProvider) and isinstance(installed_meter, MeterProvider):
        return Telemetry(
            exporting=endpoint is not None,
            _tracer_provider=installed_tracer,
            _meter_provider=installed_meter,
        )

    resource = Resource.create(
        {
            "service.name": SERVICE_NAME,
            "service.version": version,
            "deployment.environment.name": env,
        }
    )

    tracer_provider = TracerProvider(resource=resource)
    readers = []

    if endpoint is not None:
        tracer_provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces"))
        )
        readers.append(
            PeriodicExportingMetricReader(OTLPMetricExporter(endpoint=f"{endpoint}/v1/metrics"))
        )

    meter_provider = MeterProvider(resource=resource, metric_readers=readers)

    trace.set_tracer_provider(tracer_provider)
    metrics.set_meter_provider(meter_provider)

    return Telemetry(
        exporting=endpoint is not None,
        _tracer_provider=tracer_provider,
        _meter_provider=meter_provider,
    )
