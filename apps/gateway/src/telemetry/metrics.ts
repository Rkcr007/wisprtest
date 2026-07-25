import { metrics, type Counter, type Histogram, type Meter } from '@opentelemetry/api';

/**
 * The metrics from docs/ARCHITECTURE.md § 7 that the gateway is responsible for.
 *
 * § 7 names the metrics for the whole system; most are extension-side. Four of them are
 * recorded here, because the gateway is the process that knows their values:
 *
 * | Metric                              | Recorded when                          | Fed from   |
 * |-------------------------------------|----------------------------------------|------------|
 * | `wispr_seed_plan_latency_ms`        | `POST /v1/seed/plan` returns a plan     | Phase 15   |
 * | `wispr_seed_materialize_total`      | the materializer chain settles          | Phases 15–16 |
 * | `wispr_tier_total`                  | alias write-back and step ingest report a tier | Phases 11–12 |
 * | `wispr_false_execution_total`       | a step arrives with a false execution   | Phase 12   |
 *
 * The instruments exist now even though their product call sites do not. That is deliberate and
 * it is not a placeholder: an instrument is an API, later phases increment it by importing it
 * from here, and a dashboard that starts reporting a metric only once it first fires cannot
 * distinguish "zero" from "not deployed yet". Each is exercised by a test that records a value
 * and reads it back through an in-memory reader, so none of this is unverified.
 *
 * `wispr_false_execution_total` is the one that matters most. CLAUDE.md makes false execution
 * rate a release gate and ARCHITECTURE § 7 says it "alerts at any nonzero rate", so it is
 * registered here from the beginning rather than added once there is something to count.
 */

export const METER_NAME = 'wispr.gateway';

export interface GatewayMetrics {
  /** Time to compose a plan. Budgeted at p95 < 1.2 s in CLAUDE.md § "Performance budgets". */
  readonly seedPlanLatencyMs: Histogram;
  /** Materialization outcomes, by adapter — this is how a silent fallback becomes visible. */
  readonly seedMaterializeTotal: Counter;
  /** Resolution tier distribution. The single best health metric for the compounding loop. */
  readonly tierTotal: Counter;
  /** False executions. Alerts at any nonzero value; there is no acceptable rate. */
  readonly falseExecutionTotal: Counter;
  /** Requests served, by route, status and outcome. Gateway-native rather than from § 7. */
  readonly httpRequestsTotal: Counter;
  /** Request duration, so a latency regression is visible without an APM. */
  readonly httpRequestDurationMs: Histogram;
}

export function createMetrics(meter: Meter = metrics.getMeter(METER_NAME)): GatewayMetrics {
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
    falseExecutionTotal: meter.createCounter('wispr_false_execution_total', {
      description: 'Actions executed against the wrong element. Alerts at any nonzero rate.',
    }),
    httpRequestsTotal: meter.createCounter('wispr_gateway_requests_total', {
      description: 'HTTP requests served, labelled by route, method and status class.',
    }),
    httpRequestDurationMs: meter.createHistogram('wispr_gateway_request_duration_ms', {
      description: 'HTTP request duration, in milliseconds.',
      unit: 'ms',
    }),
  };
}
