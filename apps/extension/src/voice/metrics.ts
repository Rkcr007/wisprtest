/**
 * A minimal metrics sink for the extension.
 *
 * The Node services emit OpenTelemetry histograms to Prometheus (ARCHITECTURE § 7). An MV3
 * offscreen document has no such collector reachable on the hot path, and dragging an OTel SDK
 * into a bundle injected next to a customer's page is neither cheap nor necessary. What this phase
 * needs is a *seam*: a place `wispr_speech_to_partial_ms` is recorded, so the worker can forward it
 * to the gateway's telemetry route out of band and a test can assert it was recorded at all.
 *
 * The default sink writes one structured JSON line — the same shape `log.ts` emits — which is
 * queryable alongside every other extension and service log. Tests pass their own sink and read
 * the values back.
 */

export interface MetricSample {
  readonly name: string;
  readonly valueMs: number;
}

export type MetricSink = (sample: MetricSample) => void;

export interface Metrics {
  /** Record one observation of a millisecond-valued histogram. */
  observeMs(name: string, valueMs: number): void;
}

export function createMetrics(sink: MetricSink): Metrics {
  return {
    observeMs(name, valueMs) {
      // Guard against a negative or non-finite delta (a clock that went backwards, an unset
      // onset): a poisoned sample is worse than a missing one, because it skews the p95 the
      // release gate reads.
      if (!Number.isFinite(valueMs) || valueMs < 0) return;
      sink({ name, valueMs });
    },
  };
}

/** Default sink: one JSON line, readable in the offscreen document's console and any log drain. */
export const consoleMetricSink: MetricSink = (sample) => {
  console.log(
    JSON.stringify({
      metric: sample.name,
      value_ms: Math.round(sample.valueMs * 1000) / 1000,
      unit: 'ms',
      time: new Date().toISOString(),
    }),
  );
};
