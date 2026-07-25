import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { sql } from 'kysely';

import type { GatewayConfig } from '../config.js';
import type { TenantDatabase } from '../db/pool.js';

/**
 * Liveness and readiness.
 *
 * The distinction is the whole point, and getting it backwards causes outages:
 *
 * - **`/healthz`** answers "is this process alive?" It touches nothing external. If it checked
 *   dependencies, a brief database blip would make the orchestrator kill and restart every
 *   replica — turning a recoverable dependency problem into a full outage, at the exact moment
 *   the dependency can least afford a thundering herd of reconnections.
 * - **`/readyz`** answers "should traffic be routed here?" It really does check postgres, redis
 *   and qdrant, and reports each one individually, so a failure names the dependency instead of
 *   sending whoever is on call to look at all three.
 *
 * Both are public and both are exempt from rate limiting; a probe that can be throttled will
 * eventually mark a healthy service dead.
 */

interface DependencyStatus {
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs: number;
  /** Present only on failure. A message, never a stack trace or a connection string. */
  readonly error?: string;
}

export interface HealthOptions {
  readonly config: GatewayConfig;
  readonly database: TenantDatabase;
  readonly redis: Redis;
  /** How long a single dependency check may take before it counts as failed. */
  readonly probeTimeoutMs?: number;
}

export function registerHealth(app: FastifyInstance, options: HealthOptions): void {
  const timeoutMs = options.probeTimeoutMs ?? 2_000;

  app.get('/healthz', { config: { public: true } }, () => ({ status: 'ok' }));

  app.get('/readyz', { config: { public: true } }, async (_request, reply) => {
    const checks = await Promise.all([
      probe('postgres', timeoutMs, async () => {
        // Unscoped deliberately: readiness has no tenant, and `SELECT 1` reads no data.
        await options.database.unscoped('readiness-probe', async (db) => {
          await sql`SELECT 1`.execute(db);
        });
      }),
      probe('redis', timeoutMs, async () => {
        await options.redis.ping();
      }),
      probe('qdrant', timeoutMs, async () => {
        const response = await fetch(new URL('/readyz', options.config.QDRANT_URL), {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`responded ${String(response.status)}`);
      }),
    ]);

    const ready = checks.every((check) => check.ok);
    // 503 rather than 200-with-a-body: a load balancer reads the status code, not the payload.
    reply.code(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', checks };
  });
}

async function probe(
  name: string,
  timeoutMs: number,
  check: () => Promise<void>,
): Promise<DependencyStatus> {
  const startedAt = performance.now();

  try {
    await withTimeout(check(), timeoutMs, name);
    return { name, ok: true, durationMs: Math.round(performance.now() - startedAt) };
  } catch (error: unknown) {
    return {
      name,
      ok: false,
      durationMs: Math.round(performance.now() - startedAt),
      // The message only. A driver error can carry the connection string, and readiness is
      // typically the one endpoint left unauthenticated.
      error: error instanceof Error ? error.message : 'check failed',
    };
  }
}

/**
 * Bound a check that might hang.
 *
 * A dependency that accepts the connection and then never answers is the common failure, and it
 * is worse than one that refuses outright: without a timeout the probe hangs, the orchestrator
 * times out instead, and the reported reason is the probe rather than the dependency.
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${name} did not respond within ${String(timeoutMs)}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
