import {
  metrics,
  type Counter,
  type Histogram,
  type Meter,
  type ObservableGauge,
  type UpDownCounter,
} from '@opentelemetry/api';

/**
 * The metrics from docs/ARCHITECTURE.md § 7 that the gateway is responsible for.
 *
 * § 7 names the metrics for the whole system; most are extension-side. The gateway records the
 * server-side values and refreshes fleet state from Postgres:
 *
 * | Metric                              | Recorded when                          | Fed from   |
 * |-------------------------------------|----------------------------------------|------------|
 * | `wispr_seed_plan_latency_ms`        | `POST /v1/seed/plan` returns a plan     | Phase 15   |
 * | `wispr_seed_materialize_total`      | the materializer chain settles          | Phases 15–16 |
 * | `wispr_tier_total`                  | alias write-back and step ingest report a tier | Phases 11–12 |
 * | `wispr_session_steps_total`         | a batch of steps is ingested            | Phase 19   |
 * | `wispr_false_execution_total`       | a tester files a false-execution report | Phase 19   |
 * | `wispr_false_execution_withdrawn_total` | a tester withdraws one              | Phase 19   |
 * | `wispr_drift_open_total`            | periodic fleet-state refresh             | Phase 19   |
 * | `wispr_memory_staleness_hours`      | periodic fleet-state refresh             | Phase 19   |
 *
 * Observable callbacks read an atomically replaced in-memory snapshot because OTel collection is
 * synchronous. The asynchronous database refresh lives in `operational-metrics.ts`.
 *
 * `wispr_false_execution_total` is the one that matters most. CLAUDE.md makes false execution
 * rate a release gate and ARCHITECTURE § 7 says it "alerts at any nonzero rate", so it was
 * registered from the beginning rather than added once there was something to count. It finally
 * has a producer: `POST /v1/sessions/:id/false-executions`.
 *
 * ## Reading the release gate takes three series, not one
 *
 * The budget is a *rate*, and a counter cannot express one on its own:
 *
 *     (false_execution_total − false_execution_withdrawn_total) / session_steps_total{outcome="executed"}
 *
 * `wispr_session_steps_total` is the denominator, and it exists because `wispr_tier_total` is
 * not one: that series is only emitted for steps whose `tier` is non-null, so it silently
 * omits every step that never resolved. A denominator that drops its hardest cases flatters
 * the number it divides.
 *
 * `wispr_false_execution_withdrawn_total` is a second counter rather than a decrement of the
 * first, because an OpenTelemetry `Counter` is monotonic and cannot go down. Converting the
 * first to a gauge would make one series do both jobs and lose the filing rate — which is the
 * number that says whether testers trust the feature enough to use it at all. `packages/protocol`
 * states this on `FalseExecutionReport`; this is the code that honours it.
 */

export const METER_NAME = 'wispr.gateway';

export interface ApplicationOperationalMetric {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly openDriftCount: number;
  readonly memoryStalenessHours: number | null;
}

export interface OperationalMetricState {
  read(): readonly ApplicationOperationalMetric[];
  replace(values: readonly ApplicationOperationalMetric[]): void;
}

/** Atomic in-memory view read synchronously by OTel observable callbacks. */
export function createOperationalMetricState(): OperationalMetricState {
  let current: readonly ApplicationOperationalMetric[] = [];

  return {
    read: () => current,
    replace: (values) => {
      current = [...values];
    },
  };
}

export interface GatewayMetrics {
  /** Time to compose a plan. Budgeted at p95 < 1.2 s in CLAUDE.md § "Performance budgets". */
  readonly seedPlanLatencyMs: Histogram;
  /** Materialization outcomes, by adapter — this is how a silent fallback becomes visible. */
  readonly seedMaterializeTotal: Counter;
  /** Resolution tier distribution. The single best health metric for the compounding loop. */
  readonly tierTotal: Counter;
  /** T2 escalation latency, labelled by tier and outcome. The 800 ms budget is measured here. */
  readonly resolutionLatencyMs: Histogram;
  /** Steps ingested, by outcome. The denominator of the false execution rate. */
  readonly sessionStepsTotal: Counter;
  /** False executions reported, by reason. Alerts at any nonzero rate. */
  readonly falseExecutionTotal: Counter;
  /** Reports withdrawn, by reason. Subtracted from the above; a Counter cannot decrement. */
  readonly falseExecutionWithdrawnTotal: Counter;
  /** Requests served, by route, status and outcome. Gateway-native rather than from § 7. */
  readonly httpRequestsTotal: Counter;
  /** Request duration, so a latency regression is visible without an APM. */
  readonly httpRequestDurationMs: Histogram;
  /** Snapshot requests, labelled by cache `result` (hit/miss). A low hit rate means churn. */
  readonly memorySnapshotTotal: Counter;
  /** Time to assemble a snapshot from Postgres on a cache miss. Paid once per version. */
  readonly memorySnapshotBuildMs: Histogram;
  /** Crawl jobs enqueued, labelled by outcome. A run of `rejected` means bounds are misconfigured. */
  readonly indexJobsEnqueuedTotal: Counter;
  /** Drift reports raised, by what noticed. The learning loop's input rate. */
  readonly driftReportsTotal: Counter;
  /**
   * Human decisions on drift reports, by decision.
   *
   * The pair worth watching together: approvals without rejections means nobody is reading the
   * diffs, and rejections climbing means reconciliation is proposing changes it should not.
   */
  readonly driftDecisionsTotal: Counter;
  /**
   * Console tabs currently watching a crawl, and so Redis connections held open for them.
   *
   * An up-down counter rather than a counter, because the number that matters is the one at rest:
   * a value that does not return to zero after a crawl ends is a leaked subscription, and that is
   * a failure nothing else in the system reports until Redis refuses new connections.
   */
  readonly indexProgressSubscribers: UpDownCounter;
  /** Progress events forwarded to a console, labelled by event kind. */
  readonly indexProgressEventsTotal: Counter;
  /** Current live drift reports per application, including open, reconciling and diffed. */
  readonly driftOpenTotal: ObservableGauge;
  /** Hours since the newest screen in an application's active memory was indexed. */
  readonly memoryStalenessHours: ObservableGauge;
}

export function createMetrics(
  meter: Meter = metrics.getMeter(METER_NAME),
  state: OperationalMetricState = createOperationalMetricState(),
): GatewayMetrics {
  const driftOpenTotal = meter.createObservableGauge('wispr_drift_open_total', {
    description: 'Live drift reports awaiting a terminal human decision, per application.',
  });
  driftOpenTotal.addCallback((result) => {
    for (const value of state.read()) {
      result.observe(value.openDriftCount, {
        tenant_id: value.tenantId,
        app_id: value.applicationId,
      });
    }
  });

  const memoryStalenessHours = meter.createObservableGauge('wispr_memory_staleness_hours', {
    description: 'Hours since the newest screen in the active memory version was indexed.',
    unit: 'h',
  });
  memoryStalenessHours.addCallback((result) => {
    for (const value of state.read()) {
      if (value.memoryStalenessHours === null) continue;
      result.observe(value.memoryStalenessHours, {
        tenant_id: value.tenantId,
        app_id: value.applicationId,
      });
    }
  });

  return {
    seedPlanLatencyMs: meter.createHistogram('wispr_seed_plan_latency_ms', {
      description: 'Time to compose a CompositionPlan, in milliseconds.',
      unit: 'ms',
    }),
    seedMaterializeTotal: meter.createCounter('wispr_seed_materialize_total', {
      description: 'Materialization attempts, labelled by adapter and outcome.',
    }),
    tierTotal: meter.createCounter('wispr_tier_total', {
      description: 'Resolutions reported to the gateway, labelled by tier.',
    }),
    resolutionLatencyMs: meter.createHistogram('wispr_resolution_latency_ms', {
      description: 'T2 escalation latency, labelled by tier and outcome.',
      unit: 'ms',
    }),
    sessionStepsTotal: meter.createCounter('wispr_session_steps_total', {
      description: 'Steps ingested, labelled by outcome. Denominator of the false execution rate.',
    }),
    falseExecutionTotal: meter.createCounter('wispr_false_execution_total', {
      description:
        'False executions reported by a tester, labelled by reason. Alerts at any nonzero rate.',
    }),
    falseExecutionWithdrawnTotal: meter.createCounter('wispr_false_execution_withdrawn_total', {
      description:
        'False-execution reports withdrawn, labelled by reason. Subtract from wispr_false_execution_total.',
    }),
    httpRequestsTotal: meter.createCounter('wispr_gateway_requests_total', {
      description: 'HTTP requests served, labelled by route, method and status class.',
    }),
    httpRequestDurationMs: meter.createHistogram('wispr_gateway_request_duration_ms', {
      description: 'HTTP request duration, in milliseconds.',
      unit: 'ms',
    }),
    memorySnapshotTotal: meter.createCounter('wispr_memory_snapshot_total', {
      description: 'Snapshot fetches, labelled by cache result (hit or miss).',
    }),
    memorySnapshotBuildMs: meter.createHistogram('wispr_memory_snapshot_build_ms', {
      description: 'Time to assemble a memory snapshot from Postgres on a cache miss.',
      unit: 'ms',
    }),
    driftReportsTotal: meter.createCounter('wispr_drift_reports_total', {
      description: 'Drift reports raised, labelled by the component that detected the mismatch.',
    }),
    driftDecisionsTotal: meter.createCounter('wispr_drift_decisions_total', {
      description: 'Human decisions on drift reports, labelled approved or rejected.',
    }),
    indexJobsEnqueuedTotal: meter.createCounter('wispr_index_jobs_enqueued_total', {
      description: 'Crawl jobs enqueued onto the indexer stream, labelled by outcome.',
    }),
    indexProgressSubscribers: meter.createUpDownCounter('wispr_index_progress_subscribers', {
      description: 'Open index-progress streams, and so Redis connections held for them.',
    }),
    indexProgressEventsTotal: meter.createCounter('wispr_index_progress_events_total', {
      description: 'Index progress events forwarded to a console, labelled by kind.',
    }),
    driftOpenTotal,
    memoryStalenessHours,
  };
}
