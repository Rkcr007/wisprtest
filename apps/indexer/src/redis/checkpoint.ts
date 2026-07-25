import type { Redis } from 'ioredis';
import { z } from 'zod';

import { tenantKey } from './client.js';

/**
 * Crawl checkpoints — the frontier half of resumability.
 *
 * docs/BUILD-PLAN.md Phase 5: "a crashed job restarts from the last completed route, not from
 * scratch." Two things have to survive for that to hold, and they live in different places on
 * purpose:
 *
 * - **What has been indexed** lives in Postgres, as the screens themselves. That is the work, and
 *   asking the database what it holds cannot disagree with what it holds.
 * - **What is left to do** lives here. The frontier is BFS state, not a deliverable: it is
 *   reconstructible in principle by re-crawling, which is exactly the cost we are avoiding.
 *
 * A checkpoint is therefore an optimisation, and it is treated as one. A missing, expired or
 * unparseable checkpoint costs a wider re-crawl, never a wrong result: the screen upserts are
 * idempotent, so re-visiting a route already indexed writes the same rows again and moves on.
 */

/** Checkpoints outlive any sane crawl but are not permanent state. */
const CHECKPOINT_TTL_SECONDS = 24 * 60 * 60;

const frontierEntrySchema = z.strictObject({
  url: z.string().min(1),
  depth: z.int().min(0),
});

const checkpointSchema = z.strictObject({
  memoryVersionId: z.uuid(),
  /** Queued, in BFS order. */
  frontier: z.array(frontierEntrySchema),
  /** URLs already dequeued — indexed, skipped, or failed. Prevents a cycle from re-running. */
  visited: z.array(z.string()),
});

export type FrontierEntry = z.infer<typeof frontierEntrySchema>;
export type CrawlCheckpoint = z.infer<typeof checkpointSchema>;

export interface CheckpointStore {
  load(): Promise<CrawlCheckpoint | null>;
  save(checkpoint: CrawlCheckpoint): Promise<void>;
  clear(): Promise<void>;
}

export function checkpointKey(tenantId: string, jobId: string): string {
  return tenantKey(tenantId, 'indexer', 'checkpoint', jobId);
}

export function createCheckpointStore(
  redis: Redis,
  tenantId: string,
  jobId: string,
  onError: (error: unknown) => void,
): CheckpointStore {
  const key = checkpointKey(tenantId, jobId);

  return {
    async load(): Promise<CrawlCheckpoint | null> {
      try {
        const raw = await redis.get(key);
        if (raw === null) return null;

        const parsed = checkpointSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) {
          // A checkpoint written by an older build is not an error worth failing a job over.
          onError(new Error('discarding an unreadable checkpoint; the crawl will re-derive it'));
          return null;
        }
        return parsed.data;
      } catch (error: unknown) {
        onError(error);
        return null;
      }
    },

    async save(checkpoint: CrawlCheckpoint): Promise<void> {
      try {
        await redis.set(key, JSON.stringify(checkpoint), 'EX', CHECKPOINT_TTL_SECONDS);
      } catch (error: unknown) {
        // Saving is best-effort for the same reason loading is: the crawl's correctness does not
        // depend on it, only its cost after a crash.
        onError(error);
      }
    },

    async clear(): Promise<void> {
      try {
        await redis.del(key);
      } catch (error: unknown) {
        onError(error);
      }
    },
  };
}
