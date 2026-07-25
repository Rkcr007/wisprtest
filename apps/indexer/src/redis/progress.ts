import type { Redis } from 'ioredis';
import { IndexProgressEvent } from 'protocol';

import { tenantKey } from './client.js';

/**
 * Live crawl progress, streamed to the console.
 *
 * docs/BUILD-PLAN.md Phase 18 describes the indexing screen as "routes, schemas and workflows
 * appearing as they are discovered". This is the stream it reads: one Redis stream per job,
 * tenant-namespaced, capped and expiring, so a long crawl cannot grow Redis without bound and an
 * abandoned one cleans itself up.
 *
 * Sequence numbers are assigned here and are monotonic per job. The console needs them to detect
 * a gap: a stream trimmed while a viewer was disconnected looks exactly like a quiet crawl unless
 * the events number themselves.
 *
 * Publishing is best-effort by design. A crawl that has indexed forty routes must not be failed
 * because a progress event could not be written — the memory is the deliverable, the telemetry is
 * not. Failures are surfaced through the error callback, which the worker logs.
 */

/** How long a job's progress stream outlives the job. Long enough to read after the fact. */
const PROGRESS_TTL_SECONDS = 24 * 60 * 60;

export interface ProgressPublisherOptions {
  readonly maxLength: number;
  /** Called when an event could not be published. Never throws into the crawl. */
  readonly onError: (error: unknown) => void;
}

/**
 * The event fields the caller supplies; identity and ordering are added here.
 *
 * Distributive on purpose — a plain `Omit` over a union collapses it to the fields every member
 * shares, which would let a caller write a `route_indexed` event with a `route_skipped` payload.
 */
type WithoutEnvelope<T> = T extends unknown
  ? Omit<T, 'jobId' | 'tenantId' | 'sequence' | 'at'>
  : never;
export type ProgressEventInput = WithoutEnvelope<IndexProgressEvent>;

export interface ProgressReporter {
  emit(event: ProgressEventInput): Promise<void>;
  /** Events published so far. The completion event's sequence, read after the crawl. */
  readonly count: number;
}

/** The stream one job's progress is published to. */
export function progressStreamKey(tenantId: string, jobId: string): string {
  return tenantKey(tenantId, 'indexer', 'progress', jobId);
}

export function createProgressReporter(
  redis: Redis,
  tenantId: string,
  jobId: string,
  options: ProgressPublisherOptions,
): ProgressReporter {
  const key = progressStreamKey(tenantId, jobId);
  let sequence = 0;

  return {
    get count() {
      return sequence;
    },

    async emit(input: ProgressEventInput): Promise<void> {
      // The assembled object is a valid member of the union by construction, but TypeScript
      // cannot see that through a spread of a union type. `safeParse` below is what actually
      // establishes it, and its result — not this value — is what gets published.
      const event: unknown = {
        ...input,
        jobId,
        tenantId,
        sequence,
        at: new Date().toISOString(),
      };
      sequence += 1;

      // Validated before publishing, not after: the console parses these with the same schema,
      // and an event that fails there is a bug we should have caught on the writing side.
      const parsed = IndexProgressEvent.safeParse(event);
      if (!parsed.success) {
        options.onError(
          new Error(
            `progress event failed contract validation: ${parsed.error.issues
              .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
              .join('; ')}`,
          ),
        );
        return;
      }

      try {
        await redis.xadd(
          key,
          'MAXLEN',
          '~',
          options.maxLength,
          '*',
          'event',
          JSON.stringify(parsed.data),
        );
        await redis.expire(key, PROGRESS_TTL_SECONDS);
      } catch (error: unknown) {
        options.onError(error);
      }
    },
  };
}
