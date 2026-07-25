import type { Redis } from 'ioredis';
import { CrawlJob } from 'protocol';

import { namespacedKey } from './client.js';

/**
 * The crawl job queue: a Redis stream with a consumer group.
 *
 * A stream rather than a list because of the pending-entries list, which is what makes
 * resumability work at all. A job read by a worker stays *pending* until that worker acknowledges
 * it; if the worker dies mid-crawl, the entry is still there, still owned by the dead consumer,
 * with an idle time that keeps growing. Another worker reclaims it with `XAUTOCLAIM` once it has
 * been idle long enough and continues from the checkpoint. With a list, the job would simply have
 * vanished with the process that popped it.
 *
 * ## Message shape
 *
 * One field, `job`, holding a JSON `CrawlJob`. It is parsed against the contract before anything
 * touches a browser — an unvalidated job is how an unbounded crawl or an unallowlisted target
 * would get in.
 */

/** Field name under which the job payload is stored in the stream entry. */
const JOB_FIELD = 'job';

export interface DeliveredJob {
  /** Stream entry id, needed to acknowledge the job when it finishes. */
  readonly messageId: string;
  readonly job: CrawlJob;
  /**
   * True when this entry was reclaimed from another consumer rather than read fresh.
   *
   * The crawl behaves the same either way — it resumes from whatever is already in the database —
   * but the distinction is worth logging: a stream of reclaimed jobs means workers are dying.
   */
  readonly reclaimed: boolean;
}

/** A message that could not be parsed as a `CrawlJob`. */
export interface PoisonedJob {
  readonly messageId: string;
  readonly issues: readonly string[];
}

export interface JobStream {
  /** The namespaced Redis key this stream lives at. Named so operators and tests can find it. */
  readonly key: string;

  /** Create the consumer group if it does not exist. Safe to call on every boot. */
  ensureGroup(): Promise<void>;

  /**
   * The next job to run, or null if none arrived before the block expired.
   *
   * Reclaimed work is preferred over new work: a half-finished crawl holds a `building` memory
   * version that nothing else can use, so finishing it is worth more than starting another.
   */
  next(): Promise<DeliveredJob | PoisonedJob | null>;

  /** Mark a job finished. Until this lands, the entry stays reclaimable. */
  ack(messageId: string): Promise<void>;

  /** Publish a job. Used by the gateway in later phases, and by this service's own tests. */
  publish(job: CrawlJob): Promise<string>;
}

export interface JobStreamOptions {
  readonly stream: string;
  readonly group: string;
  readonly consumer: string;
  readonly blockMs: number;
  readonly claimMinIdleMs: number;
}

export function isPoisoned(delivery: DeliveredJob | PoisonedJob): delivery is PoisonedJob {
  return 'issues' in delivery;
}

export function createJobStream(redis: Redis, options: JobStreamOptions): JobStream {
  // The configured name is relative to the namespace; every command below uses the resolved key.
  const stream = namespacedKey(options.stream);

  return {
    key: stream,

    async ensureGroup(): Promise<void> {
      try {
        // `MKSTREAM` so the group can be created before the gateway has ever enqueued anything —
        // otherwise the first worker to boot in a fresh environment crashes on a missing key.
        await redis.xgroup('CREATE', stream, options.group, '0', 'MKSTREAM');
      } catch (error: unknown) {
        // BUSYGROUP means another replica created it first, which is the normal case.
        if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error;
      }
    },

    async next(): Promise<DeliveredJob | PoisonedJob | null> {
      const reclaimed = await claimStale(redis, stream, options);
      if (reclaimed !== null) return reclaimed;

      const response = await redis.xreadgroup(
        'GROUP',
        options.group,
        options.consumer,
        'COUNT',
        1,
        'BLOCK',
        options.blockMs,
        'STREAMS',
        stream,
        // `>` means "entries never delivered to any consumer in this group".
        '>',
      );

      const entry = firstEntry(response);
      if (entry === null) return null;
      return parseEntry(entry.id, entry.fields, false);
    },

    async ack(messageId: string): Promise<void> {
      await redis.xack(stream, options.group, messageId);
    },

    async publish(job: CrawlJob): Promise<string> {
      const id = await redis.xadd(stream, '*', JOB_FIELD, JSON.stringify(job));
      if (id === null) throw new Error('redis did not return an id for the enqueued job');
      return id;
    },
  };
}

/** Reclaim one entry another consumer abandoned, if any has been idle long enough. */
async function claimStale(
  redis: Redis,
  stream: string,
  options: JobStreamOptions,
): Promise<DeliveredJob | PoisonedJob | null> {
  const [, entries] = await redis.xautoclaim(
    stream,
    options.group,
    options.consumer,
    options.claimMinIdleMs,
    '0',
    'COUNT',
    1,
  );

  const [entry] = entries as [string, string[]][];
  if (entry === undefined) return null;

  const [id, fields] = entry;
  return parseEntry(id, fields, true);
}

/** ioredis types `xreadgroup` loosely; this narrows one entry out of its nested arrays. */
function firstEntry(response: unknown): { id: string; fields: string[] } | null {
  if (!Array.isArray(response)) return null;
  const [stream] = response as [[string, [string, string[]][]]];
  const entries = stream[1];
  const [entry] = entries;
  if (entry === undefined) return null;
  return { id: entry[0], fields: entry[1] };
}

/**
 * Validate one entry against the contract.
 *
 * A message that does not parse is returned as poisoned rather than thrown: the worker
 * acknowledges it and carries on, because a job nobody can execute would otherwise be reclaimed
 * forever and would block the queue behind it on every pass.
 */
function parseEntry(
  messageId: string,
  fields: readonly string[],
  reclaimed: boolean,
): DeliveredJob | PoisonedJob {
  const index = fields.indexOf(JOB_FIELD);
  const raw = index === -1 ? undefined : fields[index + 1];
  if (raw === undefined) {
    return { messageId, issues: [`entry has no "${JOB_FIELD}" field`] };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error: unknown) {
    return { messageId, issues: [`payload is not JSON: ${describe(error)}`] };
  }

  const parsed = CrawlJob.safeParse(payload);
  if (!parsed.success) {
    return {
      messageId,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
      ),
    };
  }

  return { messageId, job: parsed.data, reclaimed };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
