import Fastify, { LogController } from 'fastify';

import { loadConfig } from './config.js';
import { ConfigError } from './errors.js';
import { Lifecycle, installSignalHandlers } from './lifecycle.js';
import { createLogger } from './logger.js';

const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    service: 'gateway',
    level: config.LOG_LEVEL,
    env: config.NODE_ENV,
  });
  const lifecycle = new Lifecycle();

  // No routes are registered here. Phase 4 of docs/BUILD-PLAN.md owns auth, tenancy, RBAC,
  // observability, /healthz and /readyz; Phase 0 is explicitly "no placeholder route handlers".
  // Per-request logging stays off until Phase 4 turns it on together with tenant/session/trace
  // binding and the redaction serialiser — no request line may carry element text.
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
  });
  lifecycle.onShutdown('http-server', () => app.close());

  await app.listen({ host: config.GATEWAY_HOST, port: config.GATEWAY_PORT });

  logger.info(
    {
      event: 'service.started',
      host: config.GATEWAY_HOST,
      port: config.GATEWAY_PORT,
      pid: process.pid,
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
    code: error instanceof ConfigError ? error.code : 'startup_failed',
    msg: error instanceof Error ? error.message : String(error),
  };
  process.stderr.write(`${JSON.stringify(line)}\n`);
  process.exit(1);
});
