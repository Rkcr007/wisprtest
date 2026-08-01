import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMetrics, METER_NAME, type GatewayMetrics } from './metrics.js';

/**
 * The § 7 instruments, exercised rather than merely declared.
 *
 * Their product call sites arrive in later phases, which is exactly why they are tested now: an
 * instrument nobody has ever recorded to is indistinguishable from one that is silently broken,
 * and the first time anyone would find out is when a dashboard stays empty during an incident.
 *
 * Each value is recorded through the real API and read back out of a real in-memory reader, so
 * what is asserted is that the metric exists, is named as ARCHITECTURE § 7 names it, and
 * carries the attributes a dashboard will group by.
 */

let provider: MeterProvider;
let exporter: InMemoryMetricExporter;
let reader: PeriodicExportingMetricReader;
let metrics: GatewayMetrics;

beforeEach(() => {
  exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  reader = new PeriodicExportingMetricReader({
    exporter,
    // Long enough that nothing exports on a timer; the tests flush explicitly.
    exportIntervalMillis: 60_000,
  });
  provider = new MeterProvider({ readers: [reader] });
  metrics = createMetrics(provider.getMeter(METER_NAME));
});

afterEach(async () => {
  await provider.shutdown();
});

/** Force a collection and return the metrics that were produced. */
async function collect(): Promise<
  { name: string; points: { value: unknown; attributes: Record<string, unknown> }[] }[]
> {
  await reader.forceFlush();
  const [resourceMetric] = exporter.getMetrics();
  const scope = resourceMetric?.scopeMetrics.find((entry) => entry.scope.name === METER_NAME);

  return (scope?.metrics ?? []).map((metric) => ({
    name: metric.descriptor.name,
    points: metric.dataPoints.map((point) => ({
      value: point.value,
      attributes: point.attributes,
    })),
  }));
}

describe('the metrics named in ARCHITECTURE § 7', () => {
  it('records a seed plan latency', async () => {
    metrics.seedPlanLatencyMs.record(842);

    const metric = (await collect()).find((entry) => entry.name === 'wispr_seed_plan_latency_ms');
    expect(metric).toBeDefined();
    // CLAUDE.md budgets this at p95 < 1.2 s, which is only checkable if it is a histogram.
    expect(metric?.points[0]?.value).toMatchObject({ count: 1, sum: 842 });
  });

  it('records a materialization outcome by adapter, so a silent fallback is visible', async () => {
    // The property docs/TEST-DATA-ENGINE.md § 4 insists on: if the API adapter failed and UI ran
    // instead, the tester exercised different code and it has to be countable.
    metrics.seedMaterializeTotal.add(1, { adapter: 'api', outcome: 'failed' });
    metrics.seedMaterializeTotal.add(1, { adapter: 'ui', outcome: 'succeeded' });

    const metric = (await collect()).find((entry) => entry.name === 'wispr_seed_materialize_total');
    expect(metric?.points).toHaveLength(2);
    expect(metric?.points.map((point) => point.attributes)).toEqual(
      expect.arrayContaining([
        { adapter: 'api', outcome: 'failed' },
        { adapter: 'ui', outcome: 'succeeded' },
      ]),
    );
  });

  it('records the tier distribution, the health metric for the compounding loop', async () => {
    // "If T0 share is not climbing, the compounding loop is broken" — which needs one series
    // per tier, not one number.
    metrics.tierTotal.add(8, { tier: 'T0' });
    metrics.tierTotal.add(2, { tier: 'T1' });
    metrics.tierTotal.add(1, { tier: 'T2' });

    const metric = (await collect()).find((entry) => entry.name === 'wispr_tier_total');
    expect(metric?.points).toHaveLength(3);
    expect(metric?.points.find((point) => point.attributes.tier === 'T0')?.value).toBe(8);
  });

  it('records false executions', async () => {
    // CLAUDE.md makes false execution rate a release gate and § 7 says it alerts at any nonzero
    // value. It is registered from the start rather than added once there is something to count,
    // so a dashboard can tell "zero" from "not deployed yet".
    metrics.falseExecutionTotal.add(1, { tier: 'T2' });

    const metric = (await collect()).find((entry) => entry.name === 'wispr_false_execution_total');
    expect(metric?.points[0]?.value).toBe(1);
  });
});

describe('the gateway-native metrics', () => {
  it('counts requests by route, method and status class', async () => {
    metrics.httpRequestsTotal.add(1, {
      route: '/v1/memory/:appId/snapshot',
      method: 'GET',
      status_class: '2xx',
    });

    const metric = (await collect()).find((entry) => entry.name === 'wispr_gateway_requests_total');
    // The route *pattern*, not the resolved path: `/v1/memory/:appId/snapshot` is a bounded
    // label set, whereas the raw URL would mint a new series per application id.
    expect(metric?.points[0]?.attributes).toMatchObject({
      route: '/v1/memory/:appId/snapshot',
    });
  });

  it('records request duration as a histogram', async () => {
    metrics.httpRequestDurationMs.record(12.5, {
      route: '/healthz',
      method: 'GET',
      status_class: '2xx',
    });
    metrics.httpRequestDurationMs.record(37.5, {
      route: '/healthz',
      method: 'GET',
      status_class: '2xx',
    });

    const metric = (await collect()).find(
      (entry) => entry.name === 'wispr_gateway_request_duration_ms',
    );
    expect(metric?.points[0]?.value).toMatchObject({ count: 2, sum: 50 });
  });
});

describe('the instrument names', () => {
  it('match ARCHITECTURE § 7 exactly', async () => {
    // A renamed metric is a silently broken dashboard and a silently broken alert. The names in
    // § 7 are the contract with Phase 19's Grafana definitions.
    metrics.seedPlanLatencyMs.record(1);
    metrics.seedMaterializeTotal.add(1, {});
    metrics.tierTotal.add(1, {});
    metrics.resolutionLatencyMs.record(1, {});
    metrics.falseExecutionTotal.add(1, {});
    metrics.httpRequestsTotal.add(1, {});
    metrics.httpRequestDurationMs.record(1, {});
    metrics.memorySnapshotTotal.add(1, {});
    metrics.memorySnapshotBuildMs.record(1, {});
    metrics.indexJobsEnqueuedTotal.add(1, {});
    metrics.indexProgressSubscribers.add(1, {});
    metrics.indexProgressEventsTotal.add(1, {});

    expect((await collect()).map((entry) => entry.name).sort()).toEqual([
      'wispr_false_execution_total',
      'wispr_gateway_request_duration_ms',
      'wispr_gateway_requests_total',
      'wispr_index_jobs_enqueued_total',
      'wispr_index_progress_events_total',
      'wispr_index_progress_subscribers',
      'wispr_memory_snapshot_build_ms',
      'wispr_memory_snapshot_total',
      'wispr_resolution_latency_ms',
      'wispr_seed_materialize_total',
      'wispr_seed_plan_latency_ms',
      'wispr_tier_total',
    ]);
  });

  it('tracks open progress streams as an up-down counter', async () => {
    // The number that matters is the one at rest. A subscriber that opened and closed must leave
    // this at zero; anything else is a leaked Redis connection nothing else in the system reports.
    metrics.indexProgressSubscribers.add(1);
    metrics.indexProgressSubscribers.add(1);
    metrics.indexProgressSubscribers.add(-2);

    const metric = (await collect()).find(
      (entry) => entry.name === 'wispr_index_progress_subscribers',
    );
    expect(metric?.points[0]?.value).toBe(0);
  });

  it('labels a snapshot fetch by cache result', async () => {
    // The compounding loop's cache-efficiency signal: a hit served the held snapshot, a miss paid
    // to reassemble it from Postgres. A low hit rate means memory is churning under the tester.
    metrics.memorySnapshotTotal.add(1, { result: 'hit' });
    metrics.memorySnapshotTotal.add(1, { result: 'miss' });

    const metric = (await collect()).find((entry) => entry.name === 'wispr_memory_snapshot_total');
    expect(metric?.points.map((point) => point.attributes)).toEqual(
      expect.arrayContaining([{ result: 'hit' }, { result: 'miss' }]),
    );
  });
});
