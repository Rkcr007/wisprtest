import { loadConfig } from './config.js';
import { createTenantDatabase } from './db/pool.js';
import { ConfigError, GatewayError } from './errors.js';
import { buildServer } from './http/server.js';
import { Lifecycle, installSignalHandlers } from './lifecycle.js';
import { createLogger } from './logger.js';
import { createRedis } from './redis/client.js';
import { createMetrics } from './telemetry/metrics.js';
import { startTelemetry } from './telemetry/otel.js';

const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/**
 * The composition root.
 *
 * Everything is constructed here and handed down; nothing reaches for a global. That is what
 * lets the integration tests build the same server against the same dependencies without
 * starting a process.
 *
 * ## Shutdown order
 *
 * Hooks drain LIFO, which is why they are registered in this order:
 *
 *   telemetry → redis → database → http server        (registered)
 *   http server → database → redis → telemetry        (drained)
 *
 * The server closes first, so it stops accepting and lets in-flight requests finish. Only then
 * are the pools closed — the reverse would pull the database out from under requests that are
 * still running, turning a clean shutdown into a burst of 500s. Telemetry is last so the spans
 * and metrics from everything above it are flushed rather than dropped.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    service: 'gateway',
    level: config.LOG_LEVEL,
    env: config.NODE_ENV,
  });
  const lifecycle = new Lifecycle();

  // Before anything else: the instrumentations patch `http`, `fastify` and `pg` as those
  // modules load, so a tracer started after the server is built produces spans for nothing.
  const telemetry = startTelemetry(config);
  lifecycle.onShutdown('telemetry', () => telemetry.shutdown());

  const redis = createRedis(config);
  lifecycle.onShutdown('redis', async () => {
    await redis.quit();
  });

  // The client is lazy and has its offline queue disabled, so the first command against an
  // unconnected client fails rather than waiting. Opening the connection here means the first
  // readiness probe reflects reality instead of reporting a race. A failure is logged and boot
  // continues: readiness is what reports a dependency being down, and a gateway that refuses to
  // start because Redis is briefly unreachable is a crash loop, not a safety measure.
  await redis.connect().catch((error: unknown) => {
    logger.warn(
      { event: 'redis.connect_failed', err: error },
      'redis is unreachable at boot; readiness will report it until it recovers',
    );
  });

  const database = createTenantDatabase(config);
  lifecycle.onShutdown('database', () => database.close());

  const app = await buildServer({
    config,
    logger,
    database,
    redis,
    metrics: createMetrics(),
  });
  lifecycle.onShutdown('http-server', () => app.close());

  await app.listen({ host: config.GATEWAY_HOST, port: config.GATEWAY_PORT });

  logger.info(
    {
      event: 'service.started',
      host: config.GATEWAY_HOST,
      port: config.GATEWAY_PORT,
      pid: process.pid,
      // Says plainly whether telemetry leaves the process, so nobody spends an afternoon
      // wondering why a collector is empty.
      otel_exporting: telemetry.exporting,
      oidc_issuer: config.OIDC_ISSUER_URL,
    },
    'gateway started',
  );

  installSignalHandlers({
    lifecycle,
    signals: SHUTDOWN_SIGNALS,
    process,
    onShutdown: (result) => {
      logger.info(
        {
          event: 'service.stopped',
          signal: result.signal,
          duration_ms: Math.round(result.durationMs),
          failed_hooks: result.failures.map((failure) => failure.name),
        },
        'gateway stopped',
      );
      process.exit(result.failures.length === 0 ? 0 : 1);
    },
  });
}

main().catch((error: unknown) => {
  // The logger depends on validated config, so a config failure has to report itself. Keep the
  // shape identical to a log line: whatever collects stdout should not need a second parser.
  const line = {
    level: 'fatal',
    time: new Date().toISOString(),
    service: 'gateway',
    event: 'service.start_failed',
    code: error instanceof GatewayError ? error.code : 'startup_failed',
    issues: error instanceof ConfigError ? error.issues : undefined,
    msg: error instanceof Error ? error.message : String(error),
  };
  process.stderr.write(`${JSON.stringify(line)}\n`);
  process.exit(1);
});
