import { gzip } from 'node:zlib';

import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { AliasWritebackBatch } from 'protocol';

import type { GatewayConfig } from '../config.js';
import type { TenantDatabase } from '../db/pool.js';
import { loadSnapshot, upsertAliases } from '../db/memory-repository.js';
import { findActiveMemoryVersion } from '../db/repositories.js';
import { GatewayError } from '../errors.js';
import { tenantKey } from '../redis/client.js';
import type { GatewayMetrics } from '../telemetry/metrics.js';

/**
 * The memory endpoints: the snapshot the extension boots from, and the alias write-back that
 * makes the compounding loop compound.
 *
 * ## Why the snapshot is cached in Redis, keyed by version
 *
 * docs/BUILD-PLAN.md Phase 8: "Cached in Redis, keyed by (tenant, app, version), invalidated on
 * version change." The version is *in the key* — `tenant:{t}:memory:{app}:v{n}` — so activating a
 * new memory version does not invalidate anything, it simply asks for a key nothing has written
 * yet, and the previous version's entry ages out on its own TTL. There is no invalidation race to
 * get wrong because there is no invalidation. The one thing that mutates a version in place is an
 * alias write-back, and that path deletes the key explicitly so the next boot sees the new
 * vocabulary.
 *
 * ## Why it is compressed
 *
 * A snapshot is screens, elements, edges and aliases for a whole application — kilobytes to
 * megabytes of JSON that the extension fetches once on attach. It is gzipped in Redis and served
 * gzipped, with `content-encoding: gzip`, so `fetch` in the service worker decompresses it
 * transparently and the bytes over the wire are a fraction of the payload.
 */

/** How long a version's snapshot lives in the cache. Version-keyed, so this is a ceiling, not a
 * correctness bound: a stale entry can only exist for a version that is still active. */
const SNAPSHOT_TTL_SECONDS = 3_600;

export interface MemoryRoutesOptions {
  readonly config: GatewayConfig;
  readonly database: TenantDatabase;
  readonly redis: Redis;
  readonly metrics: GatewayMetrics;
}

function gzipAsync(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(input, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/**
 * Where a version's assembled snapshot is cached.
 *
 * Exported because drift approval has to drop it too, and a second copy of this expression is a
 * second chance to get it wrong — an invalidation that computes a key nothing was written under
 * fails silently and leaves testers resolving against superseded memory.
 */
export function snapshotKey(tenantId: string, applicationId: string, version: number): string {
  return tenantKey(tenantId, 'memory', applicationId, `v${String(version)}`);
}

export function registerMemoryRoutes(app: FastifyInstance, options: MemoryRoutesOptions): void {
  const { database, redis, metrics } = options;

  /**
   * `GET /v1/memory/:appId/snapshot` — the compressed snapshot for the active memory version.
   *
   * A cache hit serves the held gzip buffer without touching Postgres. A miss reads the active
   * version, assembles and validates the snapshot, compresses it, stores it under the
   * version-keyed key, and serves the same bytes it just cached.
   */
  app.get<{ Params: { appId: string } }>(
    '/v1/memory/:appId/snapshot',
    { config: { permission: 'memory:read' } },
    async (request, reply) => {
      const tenantId = request.principal?.tenantId;
      if (tenantId === undefined) {
        // Unreachable: the route requires authentication, so a principal is always present here.
        // Checked rather than asserted, because a snapshot served without a tenant is a snapshot
        // served to the wrong one.
        throw new GatewayError('unauthorized', 'authentication required');
      }
      const { appId } = request.params;

      const payload = await database.withTenant('memory-snapshot', async (db) => {
        const active = await findActiveMemoryVersion(db, appId);
        if (active === undefined) {
          // No active version: still indexing, or the first crawl failed. A real answer, not an
          // internal error — the extension attaches and simply has nothing to resolve against yet.
          throw new GatewayError(
            'memory_snapshot_unavailable',
            'no active memory version for this application',
            { applicationId: appId },
          );
        }

        const key = snapshotKey(tenantId, appId, active.version);

        const cached = await redis.getBuffer(key);
        if (cached !== null) {
          metrics.memorySnapshotTotal.add(1, { result: 'hit' });
          return cached;
        }

        metrics.memorySnapshotTotal.add(1, { result: 'miss' });
        const startedAt = performance.now();
        // Non-null: an active version exists, and this runs in the same transaction that just
        // read it, so it cannot have been superseded underneath us.
        const snapshot = await loadSnapshot(db, appId);
        const compressed = await gzipAsync(Buffer.from(JSON.stringify(snapshot)));
        metrics.memorySnapshotBuildMs.record(performance.now() - startedAt);

        await redis.set(key, compressed, 'EX', SNAPSHOT_TTL_SECONDS);
        return compressed;
      });

      return (
        reply
          .header('content-type', 'application/json; charset=utf-8')
          .header('content-encoding', 'gzip')
          // Held for the session by the extension; a shared cache must never keep a tenant's memory.
          .header('cache-control', 'private, no-store')
          .send(payload)
      );
    },
  );

  /**
   * `POST /v1/memory/aliases` — batched alias write-backs for one memory version.
   *
   * Deduplicated on `(memory_version_id, phrase)`, incrementing `hits` on conflict. The batch is
   * validated against the contract before it touches the database, and the memory version it
   * names is checked to belong to the tenant so a cross-tenant id fails as a clean 422 rather than
   * as a foreign-key violation surfacing as a 500.
   */
  app.post(
    '/v1/memory/aliases',
    { config: { permission: 'alias:write' } },
    async (request, reply) => {
      const tenantId = request.principal?.tenantId;
      if (tenantId === undefined) {
        throw new GatewayError('unauthorized', 'authentication required');
      }

      const parsed = AliasWritebackBatch.safeParse(request.body);
      if (!parsed.success) {
        throw new GatewayError('validation_failed', 'invalid alias write-back batch', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'root',
            message: issue.message,
          })),
        });
      }
      const batch = parsed.data;

      const result = await database.withTenant('memory-aliases', async (db) => {
        // Scoped read: RLS makes this see only the tenant's own versions, so an id belonging to
        // another tenant reads as absent — a 422 the caller can act on, not an opaque failure.
        const version = await db
          .selectFrom('memoryVersions')
          .select(['id', 'applicationId', 'version'])
          .where('id', '=', batch.memoryVersionId)
          .executeTakeFirst();

        if (version === undefined) {
          throw new GatewayError('validation_failed', 'unknown memory version for this tenant', {
            issues: [
              { path: 'memoryVersionId', message: 'unknown memory version for this tenant' },
            ],
          });
        }

        const written = await upsertAliases(db, tenantId, batch.memoryVersionId, batch.items);

        // The snapshot for this version now carries stale aliases. Drop the cache so the next
        // boot reassembles it with the new vocabulary; the extension that wrote these back is
        // already using them locally, so nothing on the hot path waits on this.
        await redis.del(snapshotKey(tenantId, version.applicationId, version.version));

        return written;
      });

      return reply.code(200).send(result);
    },
  );
}
