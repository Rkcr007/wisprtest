import type { Redis } from 'ioredis';
import { CompositionPlan, SeedJob, SeedJobResult } from 'protocol';

import { DependencyUnavailableError, GatewayError } from '../errors.js';
import { tenantKey } from './client.js';

/**
 * The gateway's two Redis uses for seeding: holding a composed plan, and dispatching a seed job.
 *
 * ## Why the plan is held here rather than returned
 *
 * `/v1/seed/plan` hands back an id; `/v1/seed/execute` sends that id back. The plan itself never
 * leaves. That is what makes "the bytes that were previewed are the bytes that get written" true
 * rather than aspirational — a client cannot approve a record the tester did not see, because it
 * has no way to describe one.
 *
 * Redis rather than Postgres because a plan is a proposal with a lifetime of minutes. Most are
 * never approved. A table of them would be a table that is almost entirely garbage, plus a
 * cleanup job to prove it.
 *
 * ## The job stream, and the key namespace
 *
 * The same split `crawl-queue.ts` documents: the gateway applies `wispr:` through ioredis's
 * `keyPrefix` and therefore writes keys *without* it, while the indexer applies it in code. Both
 * resolve to the same key.
 *
 * | Purpose      | This module writes            | Indexer writes                  | Actual key                      |
 * |--------------|-------------------------------|---------------------------------|---------------------------------|
 * | seed jobs    | `indexer:seed` (from config)  | `wispr:indexer:seed`            | `wispr:indexer:seed`            |
 * | job result   | `seed:result:{jobId}` (BLPOP) | `wispr:seed:result:{jobId}`     | `wispr:seed:result:{jobId}`     |
 *
 * The result comes back on a single-use list rather than a pub/sub channel, because there is a
 * gap between publishing the job and starting to wait, and pub/sub drops anything published into
 * that gap. A list holds the result until it is collected.
 */

/** Field the indexer reads a job payload out of. `apps/indexer/src/redis/job-stream.ts`. */
const JOB_FIELD = 'job';

/** Where a composed plan waits for approval. Namespaced per tenant like every other key here. */
function planKey(tenantId: string, planId: string): string {
  return tenantKey(tenantId, 'seed', 'plan', planId);
}

/** Where one job's result is delivered. Must match `apps/indexer/src/redis/seed-results.ts`. */
function resultKey(jobId: string): string {
  return `seed:result:${jobId}`;
}

export interface SeedPlanStore {
  /** Hold a plan for approval. Returns when the plan is durable enough to be approved against. */
  hold(plan: CompositionPlan, ttlSeconds: number): Promise<void>;
  /** The held plan, or null when it was never held, has expired, or belongs to another tenant. */
  take(tenantId: string, planId: string): Promise<CompositionPlan | null>;
  /** Forget a plan. Called once it has been materialized, so it cannot be approved twice. */
  release(tenantId: string, planId: string): Promise<void>;
}

export function createSeedPlanStore(redis: Redis): SeedPlanStore {
  return {
    async hold(plan: CompositionPlan, ttlSeconds: number): Promise<void> {
      try {
        await redis.set(
          planKey(plan.tenantId, plan.id),
          JSON.stringify(CompositionPlan.parse(plan)),
          'EX',
          ttlSeconds,
        );
      } catch (error: unknown) {
        throw new DependencyUnavailableError('redis', { cause: error });
      }
    },

    async take(tenantId: string, planId: string): Promise<CompositionPlan | null> {
      let raw: string | null;
      try {
        // Keyed by tenant, so a plan id guessed or leaked from another tenant resolves to a key
        // this caller cannot reach. The parse below is the second line of defence, not the first.
        raw = await redis.get(planKey(tenantId, planId));
      } catch (error: unknown) {
        throw new DependencyUnavailableError('redis', { cause: error });
      }
      if (raw === null) return null;

      const parsed = CompositionPlan.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        // A plan that no longer parses is one this build cannot honour — the contract moved under
        // a plan composed by an older gateway. Refused rather than coerced: the tester approved a
        // preview rendered from the old shape, and a partial read of it is not what they saw.
        throw new GatewayError(
          'validation_failed',
          'the held plan no longer matches the contract',
          {
            planId,
          },
        );
      }
      return parsed.data;
    },

    async release(tenantId: string, planId: string): Promise<void> {
      try {
        await redis.del(planKey(tenantId, planId));
      } catch (error: unknown) {
        throw new DependencyUnavailableError('redis', { cause: error });
      }
    },
  };
}

export interface SeedJobDispatcher {
  /**
   * Send one job to the indexer's seed worker and wait for its result.
   *
   * @throws {GatewayError} `materialization_failed` when no result arrives inside `timeoutMs`.
   *   A timeout is not a failed materialization — the worker may have created the record and
   *   failed to report it — so the caller has to treat it as an unknown rather than as a no-op.
   */
  run(job: SeedJob, timeoutMs: number): Promise<SeedJobResult>;
}

/** The adapter half of a job's operation, for the error a timeout has to attribute to something. */
function adapterOf(operation: SeedJob['operation']): 'ui' | 'api' | 'fixture' {
  if (operation.startsWith('api_')) return 'api';
  if (operation.startsWith('fixture_')) return 'fixture';
  return 'ui';
}

/**
 * What a timed-out job was working on: the plan it belongs to, or its own id when reverting.
 *
 * Spelled as an exhaustive comparison rather than `operation.endsWith('_create')` because only
 * the former narrows the union — `planId` does not exist on the revert variants, and a predicate
 * TypeScript cannot follow would have to be papered over with a cast.
 */
function subjectOf(job: SeedJob): string {
  switch (job.operation) {
    case 'ui_create':
    case 'api_create':
    case 'fixture_create':
      return job.planId;
    default:
      return job.jobId;
  }
}

export function createSeedJobDispatcher(redis: Redis, stream: string): SeedJobDispatcher {
  return {
    async run(job: SeedJob, timeoutMs: number): Promise<SeedJobResult> {
      const parsed = SeedJob.parse(job);

      let messageId: string | null;
      try {
        messageId = await redis.xadd(stream, '*', JOB_FIELD, JSON.stringify(parsed));
      } catch (error: unknown) {
        throw new DependencyUnavailableError('redis', { cause: error });
      }
      if (messageId === null) throw new DependencyUnavailableError('redis');

      // `BLPOP` needs its own connection: it occupies one for the duration of the block, and this
      // client is shared with rate limiting and the memory snapshot cache, both of which would
      // stall behind a fifteen-second form fill.
      //
      // `duplicate()` copies the shared client's options, including `lazyConnect` — so it has to
      // be connected explicitly. Without this the first command fails immediately with "Stream
      // isn't writeable", which reads like a Redis outage and is not one.
      const waiter = redis.duplicate();
      try {
        await waiter.connect();
      } catch (error: unknown) {
        waiter.disconnect();
        throw new DependencyUnavailableError('redis', { cause: error });
      }

      try {
        // Rounded up, and floored at one: BLPOP's timeout is in seconds, and a sub-second value
        // rounds to zero, which means *block forever*. The one input that could produce it comes
        // from validated config, and a request that never returns is not a failure mode worth
        // leaving reachable at all.
        const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
        const popped = await waiter.blpop(resultKey(parsed.jobId), seconds);

        if (popped === null) {
          const adapter = adapterOf(parsed.operation);
          throw new GatewayError(
            'materialization_failed',
            `the ${adapter} materializer did not report back within ${String(timeoutMs)}ms`,
            { planId: subjectOf(parsed), adapter },
          );
        }

        const [, raw] = popped;
        const result = SeedJobResult.safeParse(JSON.parse(raw));
        if (!result.success) {
          throw new GatewayError('validation_failed', 'the seed worker answered off-contract', {
            issues: result.error.issues.map((issue) => ({
              path: issue.path.map(String).join('.') || 'root',
              message: issue.message,
            })),
          });
        }
        return result.data;
      } finally {
        waiter.disconnect();
      }
    },
  };
}
