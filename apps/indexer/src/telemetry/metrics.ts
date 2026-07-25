import { metrics, type Counter, type Histogram, type Meter } from '@opentelemetry/api';

/**
 * The indexer's metrics.
 *
 * docs/ARCHITECTURE.md § 7 names the system's metrics; most are extension-side or gateway-side.
 * The ones here are the indexer's own, and they exist to answer the two questions an operator
 * actually asks about a crawler:
 *
 * | Question | Metric |
 * |----------|--------|
 * | Is it keeping up? | `wispr_indexer_route_duration_ms`, `wispr_indexer_routes_total` |
 * | Is it succeeding? | `wispr_indexer_jobs_total{outcome}`, `wispr_indexer_job_duration_ms` |
 *
 * `wispr_indexer_routes_total` is labelled by outcome — indexed or skipped, and skipped by
 * reason — because a crawl that silently skips half an application looks identical to a small
 * application unless the skips are counted. CLAUDE.md § "Performance budgets" sets indexer
 * throughput at more than 8 routes per minute; that is this histogram divided into a minute.
 */

export const METER_NAME = 'wispr.indexer';

export interface IndexerMetrics {
  /** Routes visited, labelled `outcome=indexed|skipped` and, when skipped, `reason`. */
  readonly routesTotal: Counter;
  /** Wall-clock time to navigate, settle, collect and persist one route. */
  readonly routeDurationMs: Histogram;
  /** Elements written to memory. The size of what a crawl actually learned. */
  readonly elementsTotal: Counter;
  /** Navigation edges observed. */
  readonly edgesTotal: Counter;
  /** Jobs finished, labelled `outcome=completed|failed|cancelled` and, when failed, `code`. */
  readonly jobsTotal: Counter;
  /** End-to-end job duration, including browser launch and authentication. */
  readonly jobDurationMs: Histogram;
}

export function createMetrics(meter: Meter = metrics.getMeter(METER_NAME)): IndexerMetrics {
  return {
    routesTotal: meter.createCounter('wispr_indexer_routes_total', {
      description: 'Routes visited during a crawl, labelled by outcome and skip reason.',
    }),
    routeDurationMs: meter.createHistogram('wispr_indexer_route_duration_ms', {
      description: 'Time to navigate, settle, extract and persist one route, in milliseconds.',
      unit: 'ms',
    }),
    elementsTotal: meter.createCounter('wispr_indexer_elements_total', {
      description: 'Elements written to memory.',
    }),
    edgesTotal: meter.createCounter('wispr_indexer_edges_total', {
      description: 'Navigation edges observed during crawls.',
    }),
    jobsTotal: meter.createCounter('wispr_indexer_jobs_total', {
      description: 'Crawl jobs finished, labelled by outcome and failure code.',
    }),
    jobDurationMs: meter.createHistogram('wispr_indexer_job_duration_ms', {
      description: 'End-to-end crawl job duration, in milliseconds.',
      unit: 'ms',
    }),
  };
}
