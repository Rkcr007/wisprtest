import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

import type { IndexerConfig } from '../config.js';

/**
 * OpenTelemetry bootstrap.
 *
 * Started before anything else in `main.ts`: the instrumentations patch `pg` and `ioredis` as
 * those modules load, so an SDK started after the worker is built produces spans for nothing.
 *
 * With no `OTEL_EXPORTER_OTLP_ENDPOINT` the SDK still runs — spans are created and context is
 * propagated — but nothing is exported. That is the right local default and it is stated in the
 * startup line, rather than filling a developer's terminal with export failures.
 *
 * There is no HTTP instrumentation here, deliberately. The indexer's outbound HTTP *is* the crawl,
 * and a span per request would mean a span per image on every page of a customer's application:
 * enormous, and full of URLs from their staging environment. The crawl is traced at route
 * granularity by the worker instead.
 */
export interface Telemetry {
  /** Whether spans and metrics are leaving the process. Reported in the startup line. */
  readonly exporting: boolean;
  readonly shutdown: () => Promise<void>;
}

export function startTelemetry(config: IndexerConfig, version = '0.0.0'): Telemetry {
  const endpoint = config.OTEL_EXPORTER_OTLP_ENDPOINT;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.OTEL_SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: version,
      'deployment.environment.name': config.NODE_ENV,
      'wispr.worker_id': config.INDEXER_WORKER_ID,
    }),
    ...(endpoint === undefined
      ? {}
      : {
          traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
          metricReader: new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
          }),
        }),
    instrumentations: [
      // Span attributes only. `enhancedDatabaseReporting` would put query parameters on spans, and
      // a parameter here can be an element fingerprint. See CLAUDE.md § "PII rule".
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new IORedisInstrumentation({ requireParentSpan: false }),
    ],
  });

  sdk.start();

  return {
    exporting: endpoint !== undefined,
    shutdown: async () => {
      await sdk.shutdown();
    },
  };
}
