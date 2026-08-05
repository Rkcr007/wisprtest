import type { Redis } from 'ioredis';
import { SeedJobResult } from 'protocol';

import { namespacedKey } from './client.js';

/**
 * The return path for a UI materialization: one result, to one waiting caller.
 *
 * The job itself travels on a stream, like a crawl does, because the delivery guarantees are the
 * same — a worker that dies mid-form must leave the entry reclaimable. The *result* is not like a
 * crawl's, though. A crawl writes its outcome to the database and nobody is waiting; a seed job
 * has a gateway request holding a tester's browser open, and it needs the answer back.
 *
 * So the result goes to a single-use list keyed by job id, which the gateway blocks on with
 * `BLPOP`. A list rather than pub/sub deliberately: pub/sub drops a message with no subscriber
 * attached at that instant, and the gap between the gateway publishing the job and starting to
 * wait is exactly such an instant. The list holds the result until it is collected.
 *
 * ## Everything expires
 *
 * The key carries a TTL from the moment it is written. A gateway that gave up waiting — timed
 * out, redeployed, crashed — leaves a result nobody will ever read, and without an expiry those
 * accumulate one key per abandoned seed forever.
 *
 * ## The two sides namespace differently, and must still meet
 *
 * The same split `redis/client.ts` and the gateway's `crawl-queue.ts` describe: this service
 * applies the `wispr:` prefix in code, the gateway applies it through ioredis's `keyPrefix` and
 * therefore writes the key without it.
 *
 * | Purpose | Gateway writes | Indexer writes | Actual key |
 * |---------|----------------|----------------|------------|
 * | result  | `seed:result:{jobId}` (BLPOP) | `wispr:seed:result:{jobId}` (RPUSH) | `wispr:seed:result:{jobId}` |
 *
 * A mismatch here fails the way that split always fails: silently. The gateway waits out its
 * timeout on a key nothing is writing, and reports a materialization that in fact ran.
 */

/** Key one job's result is delivered on, namespaced for this service's own client. */
export function seedResultKey(jobId: string): string {
  return namespacedKey(`seed:result:${jobId}`);
}

export interface SeedResultChannel {
  /** Hand the result to whoever is waiting for this job. */
  publish(result: SeedJobResult, ttlSeconds: number): Promise<void>;
}

export function createSeedResultChannel(redis: Redis): SeedResultChannel {
  return {
    async publish(result: SeedJobResult, ttlSeconds: number): Promise<void> {
      const key = seedResultKey(result.jobId);
      // Pushed and expired in one round trip. Two commands would leave a window in which a crash
      // between them strands the key with no TTL, which is the leak this exists to prevent.
      await redis.multi().rpush(key, JSON.stringify(result)).expire(key, ttlSeconds).exec();
    },
  };
}
