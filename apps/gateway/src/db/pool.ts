import { CamelCasePlugin, Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';

import type { GatewayConfig } from '../config.js';
import { currentContext } from '../context/request-context.js';
import { TenantContextMissingError } from '../errors.js';
import type { DB } from './schema.generated.js';

/**
 * Database access, and the one rule that governs it.
 *
 * > "Tenant context propagated via AsyncLocalStorage. Every DB connection sets the RLS session
 * > variable from that context — make it impossible to query without a tenant."
 *
 * "Impossible" is doing real work in that sentence. A convention that every repository method
 * remembers to filter by tenant is not impossible to break; it is broken by the first person
 * who writes a query in a hurry. So the Kysely instance is **module-private**. Nothing outside
 * this file can obtain a query builder, and the only way to get one is
 * {@link TenantDatabase.withTenant}, which will not hand one over until it has a tenant.
 *
 * What each scoped transaction does, in order:
 *
 * 1. Reads the tenant from the ambient request context. No tenant, no connection — and the pool
 *    is not touched at all, because a checkout that is going to fail should fail before it
 *    takes a connection other requests are queued for.
 * 2. `SET LOCAL ROLE wispr_app`. The migration user is a superuser locally, and superusers
 *    bypass row-level security no matter what `FORCE` says. Without this line the policies from
 *    Phase 3 are decorative.
 * 3. `set_config('wispr.tenant_id', …, true)` — the `true` makes it transaction-local, so a
 *    pooled connection cannot carry one request's tenant into the next. It is also the
 *    parameterised form; plain `SET LOCAL` accepts only literals, and building one by string
 *    concatenation from a tenant id would put an injection into the very mechanism meant to
 *    contain them.
 *
 * Both settings are undone when the transaction ends, whether it commits or rolls back. There
 * is no cleanup path to forget.
 */

/** A query builder that has already been scoped to a tenant. */
export type ScopedDatabase = Transaction<DB>;

/** Why a caller is bypassing tenant scoping. A closed set, so the diff shows every use. */
export type UnscopedReason = 'readiness-probe' | 'principal-lookup';

export interface TenantDatabase {
  /**
   * Run `work` inside a transaction scoped to the ambient tenant.
   *
   * `operation` names the caller and appears in the error raised when there is no tenant in
   * context, which turns an otherwise baffling 500 into a pointer at the code path that
   * skipped authentication.
   */
  withTenant<T>(operation: string, work: (db: ScopedDatabase) => Promise<T>): Promise<T>;

  /**
   * Run `work` with no tenant scoping, as the owning role.
   *
   * The escape hatch, named to be conspicuous in a diff. Two callers genuinely have no tenant:
   * the readiness probe, and the principal lookup that runs during authentication *before* a
   * tenant is known. It is never reachable from a product route.
   */
  unscoped<T>(reason: UnscopedReason, work: (db: Kysely<DB>) => Promise<T>): Promise<T>;

  /** Close the pool. Called from the shutdown drain, after in-flight requests have finished. */
  close(): Promise<void>;
}

export function createTenantDatabase(config: GatewayConfig): TenantDatabase {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    // A checkout that cannot be satisfied should fail fast rather than pile up behind a pool
    // that is already saturated.
    connectionTimeoutMillis: 5_000,
  });

  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    // The generated types are camelCase; the columns are snake_case, as SQL conventionally is.
    // This plugin is what reconciles them — it rewrites identifiers on the way down and result
    // keys on the way back, so `tenantId` in a query becomes `tenant_id` in the statement.
    // Without it the types compile and every query fails at runtime on an unknown column.
    plugins: [new CamelCasePlugin()],
  });

  return {
    async withTenant<T>(
      operation: string,
      work: (scoped: ScopedDatabase) => Promise<T>,
    ): Promise<T> {
      const tenantId = currentContext()?.tenantId;
      if (tenantId === undefined) throw new TenantContextMissingError(operation);

      return db.transaction().execute(async (trx) => {
        // The role name is a constant in this file, never anything derived from a request.
        await sql`SET LOCAL ROLE wispr_app`.execute(trx);
        // `${tenantId}` is a bound parameter, not interpolated text.
        await sql`SELECT set_config('wispr.tenant_id', ${tenantId}, true)`.execute(trx);

        return work(trx);
      });
    },

    async unscoped<T>(
      _reason: UnscopedReason,
      work: (unscoped: Kysely<DB>) => Promise<T>,
    ): Promise<T> {
      return work(db);
    },

    async close(): Promise<void> {
      await db.destroy();
    },
  };
}
