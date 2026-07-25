import { loadConfig } from './config.js';
import { launchBrowser } from './crawl/browser.js';
import { createSecretResolver } from './crawl/secrets.js';
import { createTenantDatabase } from './db/pool.js';
import { ConfigError } from './errors.js';
import { startHealthServer } from './health.js';
import { installSignalHandlers, Lifecycle } from './lifecycle.js';
import { createLogger } from './logger.js';
import { createRedis } from './redis/client.js';
import { createJobStream } from './redis/job-stream.js';
import { createMetrics } from './telemetry/metrics.js';
import { startTelemetry } from './telemetry/otel.js';
import { createWorker } from './worker.js';

/**
 * Worker entrypoint.
 *
 * Start order matters and is the reverse of the drain order:
 *
 * 1. **Telemetry first.** The instrumentations patch `pg` and `ioredis` as they load; an SDK
 *    started after those modules produces spans for nothing.
 * 2. Dependencies, then the browser, then the health endpoint, then the job loop.
 *
 * Shutdown runs LIFO through the lifecycle: the loop stops accepting work and cancels the crawl
 * in flight (which leaves it reclaimable, not failed), then the health server, the browser, and
 * finally the connections everything else was using.
 */
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    service: 'indexer',
    level: config.LOG_LEVEL,
    env: config.NODE_ENV,
    workerId: config.INDEXER_WORKER_ID,
  });
  const lifecycle = new Lifecycle();

  const telemetry = startTelemetry(config);
  lifecycle.onShutdown('telemetry', () => telemetry.shutdown());

  const database = createTenantDatabase(config);
  lifecycle.onShutdown('database', () => database.close());

  const redis = createRedis(config);
  await redis.connect();
  lifecycle.onShutdown('redis', async () => {
    await redis.quit();
  });

  const browser = await launchBrowser(config.INDEXER_HEADLESS);
  lifecycle.onShutdown('browser', () => browser.close());

  const worker = createWorker({
    stream: createJobStream(redis, {
      stream: config.INDEXER_JOB_STREAM,
      group: config.INDEXER_CONSUMER_GROUP,
      consumer: config.INDEXER_WORKER_ID,
      blockMs: config.INDEXER_BLOCK_MS,
      claimMinIdleMs: config.INDEXER_CLAIM_MIN_IDLE_MS,
    }),
    database,
    redis,
    browser,
    secrets: createSecretResolver(),
    metrics: createMetrics(),
    logger,
    progressMaxLength: config.INDEXER_PROGRESS_MAXLEN,
  });

  const health = await startHealthServer({
    host: config.INDEXER_HOST,
    port: config.INDEXER_PORT,
    database,
    redis,
    logger,
    isBusy: () => worker.isBusy(),
  });
  lifecycle.onShutdown('health', () => health.close());

  const loop = worker.run();
  lifecycle.onShutdown('worker', async () => {
    worker.stop();
    // Bounded by the configured timeout: a crawl that will not wind down must not hold a
    // rolling deploy open indefinitely. Its job stays pending either way, so abandoning it costs
    // the remaining routes of one crawl, not the crawl.
    await Promise.race([loop, sleep(config.SHUTDOWN_TIMEOUT_MS)]);
  });

  logger.info(
    {
      event: 'service.started',
      pid: process.pid,
      health_port: health.port,
      job_stream: config.INDEXER_JOB_STREAM,
      consumer_group: config.INDEXER_CONSUMER_GROUP,
      headless: config.INDEXER_HEADLESS,
      telemetry_exporting: telemetry.exporting,
    },
    'indexer started',
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
        'indexer stopped',
      );
      process.exit(result.failures.length === 0 ? 0 : 1);
    },
  });

  await loop;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

try {
  await main();
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
