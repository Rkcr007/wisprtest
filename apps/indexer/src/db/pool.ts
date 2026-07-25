import { CamelCasePlugin, Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';

import type { IndexerConfig } from '../config.js';
import type { DB } from './schema.generated.js';

/**
 * Database access, tenant-scoped by construction.
 *
 * The same rule the gateway holds to (CLAUDE.md rule #7, and `apps/gateway/src/db/pool.ts`): the
 * Kysely instance is module-private, and the only way to obtain a query builder is
 * {@link TenantDatabase.withTenant}, which will not produce one without a tenant.
 *
 * The tenant differs in where it comes from. The gateway reads it from an authenticated request
 * context; the indexer reads it from the `CrawlJob` it is executing, which is why it is an
 * argument here rather than ambient. Everything after that is identical, and deliberately so:
 *
 * 1. `SET LOCAL ROLE wispr_app` — the migration user is a superuser locally, and superusers
 *    bypass row-level security no matter what `FORCE` says. Without this line the Phase 3
 *    policies are decorative.
 * 2. `set_config('wispr.tenant_id', …, true)` — transaction-local, so a pooled connection cannot
 *    carry one job's tenant into the next, and parameterised, because building a `SET LOCAL` by
 *    concatenating a tenant id would put an injection into the mechanism meant to contain them.
 *
 * Both settings unwind when the transaction ends, commit or rollback. There is no cleanup to
 * forget.
 */

/** A query builder already scoped to one tenant. */
export type ScopedDatabase = Transaction<DB>;

export interface TenantDatabase {
  /** Run `work` in a transaction scoped to `tenantId`. */
  withTenant<T>(tenantId: string, work: (db: ScopedDatabase) => Promise<T>): Promise<T>;

  /** Liveness check for `/readyz`. Takes no tenant because it reads no tenant-owned row. */
  ping(): Promise<void>;

  close(): Promise<void>;
}

export function createTenantDatabase(config: IndexerConfig): TenantDatabase {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    connectionTimeoutMillis: 5_000,
  });

  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    // Generated types are camelCase, columns are snake_case. Without this plugin every query
    // typechecks and every query fails at runtime on an unknown column.
    plugins: [new CamelCasePlugin()],
  });

  return {
    async withTenant<T>(tenantId: string, work: (scoped: ScopedDatabase) => Promise<T>) {
      return db.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE wispr_app`.execute(trx);
        await sql`SELECT set_config('wispr.tenant_id', ${tenantId}, true)`.execute(trx);
        return work(trx);
      });
    },

    async ping(): Promise<void> {
      await sql`SELECT 1`.execute(db);
    },

    async close(): Promise<void> {
      await db.destroy();
    },
  };
}
