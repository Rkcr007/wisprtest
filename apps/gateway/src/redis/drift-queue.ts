import type { Redis } from 'ioredis';
import { DriftReconcileJob } from 'protocol';

import { DependencyUnavailableError } from '../errors.js';

/**
 * Dispatching a reconcile. The gateway's only Redis use for drift.
 *
 * Unlike `seed-queue.ts` there is no waiting half here, and that asymmetry is the whole shape of
 * the learning loop. A seed job blocks a request: a tester approved a preview and is watching for
 * the record. A reconcile job blocks nothing — `BUILD-PLAN.md` Phase 17 requires drift never to
 * block the tester, so the raise returns as soon as the report exists and the worker writes its
 * diff to Postgres whenever it gets there.
 *
 * That also means a lost job is recoverable rather than silent. The report stays `open`, it is
 * visible in the console's queue, and `drift_reports.observed_route` holds everything needed to
 * enqueue it again — which is why that column exists.
 *
 * The same key-prefix split `crawl-queue.ts` documents applies: this client writes the stream name
 * from config without the `wispr:` prefix, ioredis adds it, and the indexer applies it in code.
 */

/** Field the indexer reads a job payload out of. `apps/indexer/src/redis/job-stream.ts`. */
const JOB_FIELD = 'job';

export interface DriftJobDispatcher {
  /**
   * Publish a reconcile job. Resolves once Redis has it; nothing waits for the work.
   *
   * @throws {DependencyUnavailableError} when Redis is unreachable. The caller decides what that
   *   means — for the raise route it must not fail the request, because a report that exists with
   *   no job is a recoverable state and a tester blocked by a Redis outage is not.
   */
  enqueue(job: DriftReconcileJob): Promise<{ readonly messageId: string }>;
}

export function createDriftJobDispatcher(redis: Redis, stream: string): DriftJobDispatcher {
  return {
    async enqueue(job: DriftReconcileJob): Promise<{ readonly messageId: string }> {
      // Validated before it is written. It was assembled here from validated parts, so this
      // cannot normally fail — and it is still checked, because the indexer treats a message it
      // cannot parse as poison: it acknowledges and moves on, so a malformed job is not a crash
      // anybody notices, it is a reconcile that never happens.
      const parsed = DriftReconcileJob.parse(job);

      try {
        const messageId = await redis.xadd(stream, '*', JOB_FIELD, JSON.stringify(parsed));
        if (messageId === null) throw new DependencyUnavailableError('redis');
        return { messageId };
      } catch (error: unknown) {
        if (error instanceof DependencyUnavailableError) throw error;
        throw new DependencyUnavailableError('redis', { cause: error });
      }
    },
  };
}
