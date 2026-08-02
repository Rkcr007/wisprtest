import type { Redis } from 'ioredis';
import { CrawlJob, IndexProgressEvent } from 'protocol';

import { DependencyUnavailableError } from '../errors.js';
import { tenantKey } from './client.js';

/**
 * The gateway's two ends of the indexer's Redis streams: the job queue it writes to, and the
 * per-job progress stream it reads back.
 *
 * Both wire formats are owned by `apps/indexer/src/redis` — `job-stream.ts` and `progress.ts` —
 * and are mirrored here rather than imported, because the indexer is a separate deployable that
 * the gateway does not depend on. What stops the two drifting is the contract: a job is written
 * as a `CrawlJob` and an event is read back as an `IndexProgressEvent`, both validated by
 * `packages/protocol`, so a shape change breaks a build rather than a crawl.
 *
 * ## The key namespace, which is the part that fails silently
 *
 * The indexer's `client.ts` explains at length why it applies the `wispr:` prefix in code instead
 * of through ioredis's `keyPrefix`: the prefix is applied per command from ioredis's key-position
 * metadata, and `XGROUP` has none, so a client-side prefix would attach the consumer group to a
 * different key than the one `XADD` writes.
 *
 * The gateway issues neither `XGROUP` nor any other command ioredis cannot locate the key in —
 * `XADD`, `XREAD`, `SET` and `GET` are all covered — so its client-side `keyPrefix` is safe and
 * every key below is written *without* the namespace and resolves to the same key the indexer
 * builds by hand:
 *
 * | Purpose        | This module writes                       | Resolves to                                  |
 * |----------------|------------------------------------------|----------------------------------------------|
 * | job queue      | `indexer:jobs` (from config)             | `wispr:indexer:jobs`                          |
 * | progress       | `tenant:{t}:indexer:progress:{jobId}`    | `wispr:tenant:{t}:indexer:progress:{jobId}`   |
 * | latest job     | `tenant:{t}:indexer:job:{appId}`         | `wispr:tenant:{t}:indexer:job:{appId}`        |
 *
 * The first two are the indexer's; the third is the gateway's own, and exists because the console
 * follows an *application*, while progress is published per *job*.
 */

/** Field the indexer reads a job payload out of. `apps/indexer/src/redis/job-stream.ts`. */
export const JOB_FIELD = 'job';

/** Field the indexer writes a progress event under. `apps/indexer/src/redis/progress.ts`. */
export const PROGRESS_FIELD = 'event';

/**
 * How long the application → latest job pointer lives.
 *
 * Matched to the indexer's `PROGRESS_TTL_SECONDS`: a pointer that outlived the stream it names
 * would send the console to watch a key that no longer exists, which is indistinguishable from a
 * crawl that has gone quiet.
 */
const LATEST_JOB_TTL_SECONDS = 24 * 60 * 60;

/** Entries read per `XREAD`. A burst of route events should arrive in one round trip, not fifty. */
const PROGRESS_BATCH = 100;

/** The stream one job's progress is published to. Mirrors the indexer's `progressStreamKey`. */
export function progressStreamKey(tenantId: string, jobId: string): string {
  return tenantKey(tenantId, 'indexer', 'progress', jobId);
}

/** Where the id of the most recently enqueued job for an application is remembered. */
export function latestJobKey(tenantId: string, applicationId: string): string {
  return tenantKey(tenantId, 'indexer', 'job', applicationId);
}

export interface EnqueuedJob {
  /** The stream entry id Redis assigned. Lets an operator find the exact message. */
  readonly messageId: string;
}

/**
 * Publish a job onto the stream the indexer consumes, and remember it as the application's
 * current one.
 *
 * The job is validated against the contract before it is written. It was assembled in this
 * process from validated parts, so this cannot normally fail — and it is still checked, because
 * the indexer treats a message it cannot parse as poison: it acknowledges it and moves on, so a
 * malformed job is not a crash anybody notices, it is a crawl that never happens.
 */
export async function enqueueCrawlJob(
  redis: Redis,
  stream: string,
  job: CrawlJob,
): Promise<EnqueuedJob> {
  const parsed = CrawlJob.parse(job);

  try {
    const messageId = await redis.xadd(stream, '*', JOB_FIELD, JSON.stringify(parsed));
    if (messageId === null) {
      // `XADD` without NOMKSTREAM always returns an id; null would mean the command was answered
      // by something that is not the Redis we think it is.
      throw new DependencyUnavailableError('redis');
    }

    // Written after the job, not before: a pointer to a job that was never enqueued would make
    // the progress route wait on a stream nothing will ever publish to.
    await redis.set(
      latestJobKey(parsed.tenantId, parsed.applicationId),
      parsed.jobId,
      'EX',
      LATEST_JOB_TTL_SECONDS,
    );

    return { messageId };
  } catch (error: unknown) {
    if (error instanceof DependencyUnavailableError) throw error;
    throw new DependencyUnavailableError('redis', { cause: error });
  }
}

/** The job the console should follow for an application, or null when none was ever enqueued. */
export async function findLatestJobId(
  redis: Redis,
  tenantId: string,
  applicationId: string,
): Promise<string | null> {
  try {
    return await redis.get(latestJobKey(tenantId, applicationId));
  } catch (error: unknown) {
    throw new DependencyUnavailableError('redis', { cause: error });
  }
}

/** One turn of the progress reader. */
export type ProgressDelivery =
  /** An event, validated against the contract. `messageId` doubles as the SSE event id. */
  | { readonly kind: 'event'; readonly messageId: string; readonly event: IndexProgressEvent }
  /** The block expired with nothing published. The route turns this into a keep-alive. */
  | { readonly kind: 'idle' }
  /** An entry that is not a valid `IndexProgressEvent`. Reported, never forwarded. */
  | { readonly kind: 'malformed'; readonly messageId: string; readonly issues: readonly string[] };

export interface ProgressStreamOptions {
  readonly tenantId: string;
  readonly jobId: string;
  /** Stream id to resume after. `0` replays everything still retained for the job. */
  readonly fromId: string;
  /** How long one `XREAD` blocks before yielding an `idle` turn. */
  readonly blockMs: number;
  /** Aborted when the client goes away. Ends the iteration and closes the connection. */
  readonly signal: AbortSignal;
}

/**
 * Active progress readers, and so active Redis connections held open for them.
 *
 * Exported because a leak here is invisible until Redis runs out of connections: a reader that
 * outlives its HTTP request holds a socket forever, and the symptom appears hours later in a
 * different part of the system. The metric is recorded from this value.
 */
let activeReaders = 0;
export function activeProgressReaders(): number {
  return activeReaders;
}

/**
 * Stream one job's progress until the client disconnects or the caller stops iterating.
 *
 * ## Why this takes a connection of its own
 *
 * `XREAD BLOCK` occupies the connection for the whole block. The gateway's shared client also
 * serves the rate limiter and the snapshot cache, both of which are on request paths; a blocking
 * read on it would stall every other tenant's request behind one console tab watching a crawl.
 * So each reader duplicates the client — same URL, same `keyPrefix`, same failure semantics — and
 * closes it in `finally`.
 *
 * ## Why the abort listener disconnects rather than sets a flag
 *
 * A closed browser tab must not leave a socket parked in a 15-second block. `disconnect()` tears
 * the connection down under the in-flight `XREAD`, which rejects; the abort check turns that into
 * a clean return rather than an error, and the `finally` runs on any exit path — including the
 * consumer breaking out of its `for await`.
 */
export async function* readProgressStream(
  redis: Redis,
  options: ProgressStreamOptions,
): AsyncGenerator<ProgressDelivery, void, undefined> {
  const key = progressStreamKey(options.tenantId, options.jobId);
  const subscriber = redis.duplicate();
  const abort = (): void => {
    subscriber.disconnect();
  };

  activeReaders += 1;
  options.signal.addEventListener('abort', abort, { once: true });

  /**
   * Whether the client has gone away.
   *
   * Read through a function rather than as a property, because TypeScript narrows
   * `signal.aborted` to `false` after the first guard below and then treats every later check as
   * dead code. It is not: the flag is flipped by a listener the compiler cannot see, and those
   * later checks are the only thing that stops a closed tab leaving a reader parked in a
   * fifteen-second blocking read.
   */
  const aborted = (): boolean => options.signal.aborted;

  try {
    // `lazyConnect` is inherited from the shared client's options, so a duplicate starts idle.
    if (subscriber.status === 'wait') await subscriber.connect();
    if (aborted()) return;

    let cursor = options.fromId;

    while (!aborted()) {
      let response: [key: string, items: [id: string, fields: string[]][]][] | null;
      try {
        response = await subscriber.xread(
          'COUNT',
          PROGRESS_BATCH,
          'BLOCK',
          options.blockMs,
          'STREAMS',
          key,
          cursor,
        );
      } catch (error: unknown) {
        // The disconnect above is the expected way this rejects. Anything else is a real fault.
        if (aborted()) return;
        throw new DependencyUnavailableError('redis', { cause: error });
      }

      const entries = response?.[0]?.[1] ?? [];
      if (entries.length === 0) {
        yield { kind: 'idle' };
        continue;
      }

      for (const [messageId, fields] of entries) {
        // Advanced before the yield: an event the consumer refuses must not be re-read forever.
        cursor = messageId;
        yield decodeEntry(messageId, fields, options.tenantId);
      }
    }
  } finally {
    options.signal.removeEventListener('abort', abort);
    subscriber.disconnect();
    activeReaders -= 1;
  }
}

/**
 * Turn one stream entry into a delivery.
 *
 * The tenant check is defence in depth. The key is built from the authenticated principal's
 * tenant, so an event for another tenant cannot be in this stream at all — and it is still
 * checked, because the cost of being wrong is one tenant watching another's application being
 * indexed, and the cost of the check is a string comparison.
 */
function decodeEntry(
  messageId: string,
  fields: readonly string[],
  tenantId: string,
): ProgressDelivery {
  const index = fields.indexOf(PROGRESS_FIELD);
  const raw = index === -1 ? undefined : fields[index + 1];
  if (raw === undefined) {
    return { kind: 'malformed', messageId, issues: [`entry has no "${PROGRESS_FIELD}" field`] };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error: unknown) {
    return {
      kind: 'malformed',
      messageId,
      issues: [`payload is not JSON: ${error instanceof Error ? error.message : 'unknown error'}`],
    };
  }

  const parsed = IndexProgressEvent.safeParse(payload);
  if (!parsed.success) {
    return {
      kind: 'malformed',
      messageId,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
      ),
    };
  }

  if (parsed.data.tenantId !== tenantId) {
    return {
      kind: 'malformed',
      messageId,
      issues: ['event names a different tenant than the stream it was read from'],
    };
  }

  return { kind: 'event', messageId, event: parsed.data };
}
