import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { FastifyOtelInstrumentation } from '@fastify/otel';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

import type { GatewayConfig } from '../config.js';

/**
 * OpenTelemetry bootstrap.
 *
 * Started before anything else in `main.ts`. The instrumentations patch `http`, `fastify` and
 * `pg` as those modules are loaded, so a tracer installed after the server is built produces
 * spans for nothing.
 *
 * With no `OTEL_EXPORTER_OTLP_ENDPOINT` the SDK still runs — context propagation and span
 * creation happen regardless — but nothing is exported. That is the correct local default: a
 * developer with no collector should not see export failures on every request, and the startup
 * line says plainly which mode is in effect. Phase 19 wires the collector, Prometheus and
 * Grafana; this phase's job is to make sure there is something for them to collect.
 */
export interface Telemetry {
  /** Whether spans and metrics are leaving the process. Reported in the startup line. */
  readonly exporting: boolean;
  readonly shutdown: () => Promise<void>;
}

export function startTelemetry(config: GatewayConfig, version = '0.0.0'): Telemetry {
  const endpoint = config.OTEL_EXPORTER_OTLP_ENDPOINT;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.OTEL_SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: version,
      'deployment.environment.name': config.NODE_ENV,
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
      // `/healthz` and `/readyz` are polled by the orchestrator every few seconds. Tracing them
      // would bury every real request under liveness noise and multiply the export bill.
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => {
          const url = request.url ?? '';
          return url.startsWith('/healthz') || url.startsWith('/readyz');
        },
      }),
      // `@fastify/otel`, not `@opentelemetry/instrumentation-fastify`: the latter is
      // deprecated in favour of this one, which the Fastify maintainers own.
      new FastifyOtelInstrumentation({ registerOnInitialization: true }),
      // Span attributes only; `enhancedDatabaseReporting` would put query parameters on spans,
      // and a parameter can be a customer's data. See CLAUDE.md § "PII rule".
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
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
