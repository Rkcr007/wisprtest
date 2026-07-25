import type { Kysely, Selectable } from 'kysely';

import type { ScopedDatabase, TenantDatabase } from './pool.js';
import type { Application, DB, MemoryVersion, User } from './schema.generated.js';

/**
 * The repository layer.
 *
 * Phase 4 is infrastructure, and docs/BUILD-PLAN.md is explicit that no product endpoint is
 * built here — so these are the reads the *infrastructure itself* performs, and nothing more:
 * the principal lookup that authentication needs, and the tenant-scoped reads whose only job
 * right now is to prove the scoping works end to end. Memory, seed and session repositories
 * belong to the phases that own those endpoints.
 *
 * Every method takes a `ScopedDatabase`, which can only come from `withTenant`. None of them
 * writes a `where tenant_id = …` clause, and that is the point: row-level security applies it,
 * so a method that forgets cannot leak. The Phase 3 test suite proves the database enforces it;
 * these repositories rely on that rather than duplicating it in application code, because a
 * duplicated filter is one that can drift.
 */

export type UserRow = Selectable<User>;
export type ApplicationRow = Selectable<Application>;
export type MemoryVersionRow = Selectable<MemoryVersion>;

/** What authentication needs to turn a verified token into a request context. */
export interface Principal {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: string;
  readonly email: string;
}

/**
 * Resolve a verified token's subject to a principal.
 *
 * Runs unscoped, and has to: this is the query that *determines* the tenant, so there is no
 * tenant to scope it by yet. It is the one read in the service that is allowed to cross tenant
 * boundaries, it looks up exactly one row by a value the identity provider signed, and it
 * returns null rather than throwing so the caller can decide what an unknown subject means.
 */
export async function findPrincipalByEmail(
  database: TenantDatabase,
  email: string,
): Promise<Principal | null> {
  return database.unscoped('principal-lookup', async (db: Kysely<DB>) => {
    const row = await db
      .selectFrom('users')
      .select(['id', 'tenantId', 'role', 'email'])
      // Addresses are unique per tenant and compared case-insensitively, matching the
      // `users_tenant_email_key` index. `limit(2)` rather than `limit(1)` so an address that
      // somehow exists in two tenants is detected instead of silently resolving to whichever
      // row the planner returned first.
      .where((eb) => eb.fn('lower', ['email']), '=', email.toLowerCase())
      .limit(2)
      .execute();

    const [only] = row;
    if (only === undefined || row.length > 1) return null;

    return { userId: only.id, tenantId: only.tenantId, role: only.role, email: only.email };
  });
}

/** Every user in the ambient tenant. Scoped by row-level security, not by a where clause. */
export async function listUsers(db: ScopedDatabase): Promise<UserRow[]> {
  return db.selectFrom('users').selectAll().orderBy('email').execute();
}

/** Every application in the ambient tenant. */
export async function listApplications(db: ScopedDatabase): Promise<ApplicationRow[]> {
  return db.selectFrom('applications').selectAll().orderBy('name').execute();
}

/**
 * The active memory version for an application, if there is one.
 *
 * The read Phase 8's snapshot endpoint begins with, and the reason
 * `memory_versions_one_active_per_application` is a partial unique index: at most one row can
 * match, enforced by the database rather than by this query hoping.
 */
export async function findActiveMemoryVersion(
  db: ScopedDatabase,
  applicationId: string,
): Promise<MemoryVersionRow | undefined> {
  return db
    .selectFrom('memoryVersions')
    .selectAll()
    .where('applicationId', '=', applicationId)
    .where('status', '=', 'active')
    .executeTakeFirst();
}
