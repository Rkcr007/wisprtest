import { loadConfig } from './config.js';
import { ConfigError } from './errors.js';
import { holdEventLoop } from './keep-alive.js';
import { Lifecycle, installSignalHandlers } from './lifecycle.js';
import { createLogger } from './logger.js';

const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

function main(): void {
  const config = loadConfig();
  const logger = createLogger({
    service: 'indexer',
    level: config.LOG_LEVEL,
    env: config.NODE_ENV,
    workerId: config.INDEXER_WORKER_ID,
  });
  const lifecycle = new Lifecycle();

  // No job stream is consumed here. Phase 5 of docs/BUILD-PLAN.md owns the Redis stream
  // consumer, the Playwright crawl and the memory_version writer.
  const keepAlive = holdEventLoop();
  lifecycle.onShutdown('keep-alive', () => {
    keepAlive.release();
  });

  logger.info({ event: 'service.started', pid: process.pid }, 'indexer started');

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
        'indexer stopped',
      );
      process.exit(result.failures.length === 0 ? 0 : 1);
    },
  });
}

try {
  main();
} catch (error: unknown) {
  const line = {
    level: 'fatal',
    time: new Date().toISOString(),
    service: 'indexer',
    event: 'service.start_failed',
    code: error instanceof ConfigError ? error.code : 'startup_failed',
    msg: error instanceof Error ? error.message : String(error),
  };
  process.stderr.write(`${JSON.stringify(line)}\n`);
  process.exit(1);
}
