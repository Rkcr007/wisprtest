import { z } from 'zod';

import { ConfigError } from './errors.js';

/**
 * Indexer configuration, read from the process environment and validated at boot.
 *
 * No defaults — CLAUDE.md rule #10 requires a loud boot failure over a silent fallback.
 * `INDEXER_WORKER_ID` in particular has to be explicit: it is this worker's identity in the
 * Redis consumer group, and two workers silently sharing a generated default would each claim
 * the other's abandoned jobs.
 *
 * Note what is *not* here: nothing about what to crawl. Origins, depth, page cap, the
 * never-interact list and the auth profile all arrive on the job, because they are
 * per-application knowledge (CLAUDE.md § "generic vs per-application") and because the record of
 * what a crawl was permitted to do should be the same record that was executed.
 */
const indexerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  /** Stable identity in logs and in the Redis consumer group. */
  INDEXER_WORKER_ID: z.string().min(1),

  // ── Health endpoint ──────────────────────────────────────────────────────────────────────────
  // The indexer is a worker, not an API, but rule #6 applies to every service: an orchestrator
  // that cannot probe it will restart a healthy worker mid-crawl or leave a wedged one running.
  INDEXER_HOST: z.string().min(1),
  INDEXER_PORT: z.coerce.number().int().positive().max(65535),

  // ── Dependencies ─────────────────────────────────────────────────────────────────────────────
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(1000),

  // ── Job stream ───────────────────────────────────────────────────────────────────────────────
  /** Redis stream the gateway enqueues `CrawlJob`s on. */
  INDEXER_JOB_STREAM: z.string().min(1),
  /** Consumer group shared by every worker replica. */
  INDEXER_CONSUMER_GROUP: z.string().min(1),
  /** How long a read blocks waiting for work before the loop checks for shutdown. */
  INDEXER_BLOCK_MS: z.coerce.number().int().min(100).max(60_000),
  /**
   * How long a delivered job may sit unacknowledged before another worker may claim it.
   *
   * This is the resumability lever: a worker that dies holding a job leaves the message pending,
   * and after this interval a surviving worker takes it over and continues from the checkpoint.
   * Too low and two workers fight over a live crawl; too high and a crash stalls the queue.
   */
  INDEXER_CLAIM_MIN_IDLE_MS: z.coerce.number().int().min(1000),
  /** Cap on retained progress events per job, so a long crawl cannot grow Redis without bound. */
  INDEXER_PROGRESS_MAXLEN: z.coerce.number().int().min(100).max(1_000_000),

  // ── Seed jobs ────────────────────────────────────────────────────────────────────────────────
  /**
   * Redis stream the gateway enqueues `UiSeedJob`s on. Separate from the crawl stream.
   *
   * Two streams rather than one, because the two kinds of work have opposite urgencies: a crawl
   * runs for minutes and nobody is waiting, a seed job has a tester's request held open behind it.
   * Sharing a stream would put a seed behind a crawl in the same consumer group, and the request
   * would time out while a browser worked through someone else's routes.
   */
  INDEXER_SEED_STREAM: z.string().min(1),
  /** Consumer group for the seed stream, shared by every worker replica. */
  INDEXER_SEED_CONSUMER_GROUP: z.string().min(1),
  /**
   * How long a seed result waits to be collected before Redis reclaims it.
   *
   * Sized above the gateway's own wait: the result must outlive the request that asked for it, so
   * that a gateway retrying after a blip can still find it. Not much above — an uncollected result
   * describes a record that exists in a customer's application, and it should not linger.
   */
  INDEXER_SEED_RESULT_TTL_SECONDS: z.coerce.number().int().min(10).max(3600),

  // ── Browser ──────────────────────────────────────────────────────────────────────────────────
  /** Headless everywhere except when a developer is watching a crawl to debug it. */
  INDEXER_HEADLESS: z.enum(['true', 'false']).transform((value) => value === 'true'),

  // ── Observability ────────────────────────────────────────────────────────────────────────────
  OTEL_SERVICE_NAME: z.string().min(1),
  /** Absent means export nothing: the right local default, and it is reported at boot. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),

  // ── Shutdown ─────────────────────────────────────────────────────────────────────────────────
  /** How long a crawl in flight may finish its current route before it is abandoned. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0),
});

export type IndexerConfig = z.infer<typeof indexerEnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const result = indexerEnvSchema.safeParse(env);

  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const variable = issue.path.map(String).join('.');
        return variable === '' ? issue.message : `${variable}: ${issue.message}`;
      }),
    );
  }

  return result.data;
}
