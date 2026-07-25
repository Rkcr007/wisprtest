import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asTenant,
  asUnscopedApp,
  connect,
  CONTOSO,
  NORTHWIND,
  TENANT_SCOPED_TABLES,
} from './support.js';

/**
 * Tenant isolation, proved against the real database.
 *
 * The claim under test is the one CLAUDE.md rule #7 makes: scoping is enforced by the database,
 * not by application code. So every assertion here is made through a correctly-formed query that
 * simply *omits* a tenant filter — the mistake a repository method will eventually make — and
 * checks that the database returns nothing rather than somebody else's rows.
 */

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

describe('the premise', () => {
  it('has both tenants in the database, or the isolation tests prove nothing', async () => {
    // A tenant-isolation test run against a single-tenant database passes whether the policy
    // works or not, because there are no other rows to leak. This asserts there are.
    const { rows } = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM tenants WHERE id = ANY($1)',
      [[NORTHWIND.tenantId, CONTOSO.tenantId]],
    );
    expect(rows[0]?.count).toBe('2');
  });

  it('confirms the migration user bypasses RLS, which is why the tests use SET ROLE', async () => {
    // Not a property we want — a fact we have to work around. Superusers ignore row-level
    // security regardless of FORCE, so a test that connected and queried directly would see
    // everything and pass vacuously. Asserting it here means the day someone removes the
    // `SET ROLE` from `asTenant`, the reason it was there is written down next to the failure.
    const { rows } = await client.query<{ super: boolean }>(
      'SELECT usesuper AS super FROM pg_user WHERE usename = current_user',
    );
    expect(rows[0]?.super).toBe(true);

    const all = await client.query('SELECT id FROM applications');
    expect(all.rowCount).toBeGreaterThanOrEqual(2);
  });
});

describe('a session scoped to tenant A cannot read tenant B', () => {
  it('returns only its own applications from an unfiltered select', async () => {
    const ids = await asTenant(client, NORTHWIND.tenantId, async (scoped) => {
      // No WHERE clause. This is the query a repository writes when it forgets to scope.
      const { rows } = await scoped.query<{ id: string }>('SELECT id FROM applications');
      return rows.map((row) => row.id);
    });

    expect(ids).toEqual([NORTHWIND.applicationId]);
    expect(ids).not.toContain(CONTOSO.applicationId);
  });

  it('cannot reach the other tenant even when asking for its row by primary key', async () => {
    const rowCount = await asTenant(client, NORTHWIND.tenantId, async (scoped) => {
      const result = await scoped.query('SELECT id FROM applications WHERE id = $1', [
        CONTOSO.applicationId,
      ]);
      return result.rowCount;
    });

    expect(rowCount).toBe(0);
  });

  it('sees the mirror image from the other side', async () => {
    const ids = await asTenant(client, CONTOSO.tenantId, async (scoped) => {
      const { rows } = await scoped.query<{ id: string }>('SELECT id FROM applications');
      return rows.map((row) => row.id);
    });

    expect(ids).toEqual([CONTOSO.applicationId]);
  });

  it('isolates users, including two accounts that differ only by tenant', async () => {
    const emails = await asTenant(client, NORTHWIND.tenantId, async (scoped) => {
      const { rows } = await scoped.query<{ email: string }>('SELECT email FROM users');
      return rows.map((row) => row.email).sort();
    });

    expect(emails).toEqual(['daniel.tester@northwind.example', 'priya.lead@northwind.example']);
    expect(emails.some((email) => email.endsWith('@contoso.example'))).toBe(false);
  });

  it('isolates the tenants table itself, whose own id is the tenant', async () => {
    const names = await asTenant(client, NORTHWIND.tenantId, async (scoped) => {
      const { rows } = await scoped.query<{ name: string }>('SELECT name FROM tenants');
      return rows.map((row) => row.name);
    });

    expect(names).toEqual(['Northwind QA']);
  });

  it('isolates memory versions, which are reached only through an application', async () => {
    const ids = await asTenant(client, NORTHWIND.tenantId, async (scoped) => {
      const { rows } = await scoped.query<{ id: string }>('SELECT id FROM memory_versions');
      return rows.map((row) => row.id);
    });

    expect(ids).toEqual([NORTHWIND.memoryVersionId]);
  });

  it('does not leak the other tenant through a join either', async () => {
    // Policies apply per table, so a join is filtered on both sides. Worth asserting: a join is
    // how a leak would most plausibly appear once repositories get more interesting.
    const rowCount = await asTenant(client, NORTHWIND.tenantId, async (scoped) => {
      const result = await scoped.query(
        `SELECT a.id
           FROM applications a
           JOIN memory_versions m ON m.application_id = a.id
          WHERE m.id = $1`,
        [CONTOSO.memoryVersionId],
      );
      return result.rowCount;
    });

    expect(rowCount).toBe(0);
  });

  it('hides the other tenant from an aggregate, not just from a row read', async () => {
    // `count(*)` is the shape that leaks information without returning a row, and it is what a
    // "how many applications exist" dashboard query looks like.
    const count = await asTenant(client, NORTHWIND.tenantId, async (scoped) => {
      const { rows } = await scoped.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM applications',
      );
      return rows[0]?.count;
    });

    expect(count).toBe('1');
  });
});

describe('writes are scoped too, not just reads', () => {
  it('refuses an insert that claims another tenant', async () => {
    // WITH CHECK, not just USING. Without it a tenant could write rows it cannot then see —
    // a write you cannot audit is worse than a read you cannot perform.
    await expect(
      asTenant(client, NORTHWIND.tenantId, async (scoped) => {
        await scoped.query(
          `INSERT INTO applications (tenant_id, name, base_url, env)
           VALUES ($1, 'Smuggled', 'https://smuggled.example', 'staging')`,
          [CONTOSO.tenantId],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('allows an insert for its own tenant', async () => {
    const inserted = await asTenant(client, NORTHWIND.tenantId, async (scoped) => {
      const { rows } = await scoped.query<{ id: string }>(
        `INSERT INTO applications (tenant_id, name, base_url, env)
         VALUES ($1, 'Northwind Billing', 'https://billing.northwind.example', 'development')
         RETURNING id`,
        [NORTHWIND.tenantId],
      );
      return rows[0]?.id;
    });

    expect(inserted).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('cannot update another tenant’s row', async () => {
    const updated = await asTenant(client, NORTHWIND.tenantId, async (scoped) => {
      const result = await scoped.query('UPDATE applications SET name = $1 WHERE id = $2', [
        'hijacked',
        CONTOSO.applicationId,
      ]);
      return result.rowCount;
    });

    // Zero rows rather than an error: the row is invisible, so there is nothing to update.
    expect(updated).toBe(0);
  });

  it('cannot move one of its own rows into another tenant', async () => {
    await expect(
      asTenant(client, NORTHWIND.tenantId, async (scoped) => {
        await scoped.query('UPDATE applications SET tenant_id = $1 WHERE id = $2', [
          CONTOSO.tenantId,
          NORTHWIND.applicationId,
        ]);
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot delete another tenant’s row', async () => {
    const deleted = await asTenant(client, NORTHWIND.tenantId, async (scoped) => {
      const result = await scoped.query('DELETE FROM applications WHERE id = $1', [
        CONTOSO.applicationId,
      ]);
      return result.rowCount;
    });

    expect(deleted).toBe(0);
  });
});

describe('fail-closed', () => {
  it('returns nothing at all when no tenant has been declared', async () => {
    // The important direction. A policy that defaulted to "everything" when the setting was
    // missing would turn one forgotten `SET LOCAL` into a full cross-tenant disclosure.
    const counts = await asUnscopedApp(client, async (scoped) => {
      const results: Record<string, number> = {};
      for (const table of TENANT_SCOPED_TABLES) {
        const result = await scoped.query(`SELECT * FROM ${table}`);
        results[table] = result.rowCount ?? -1;
      }
      return results;
    });

    for (const table of TENANT_SCOPED_TABLES) {
      expect(counts[table], `${table} leaked rows with no tenant set`).toBe(0);
    }
  });

  it('returns nothing when the tenant setting is present but empty', async () => {
    // `''::uuid` raises rather than returning NULL, so without the `nullif` in
    // `app_current_tenant_id()` this case would throw from inside a policy — a far worse
    // failure mode than an empty result, and one that only shows up in production.
    const rowCount = await asUnscopedApp(client, async (scoped) => {
      await scoped.query('SELECT set_config($1, $2, true)', ['wispr.tenant_id', '']);
      const result = await scoped.query('SELECT id FROM applications');
      return result.rowCount;
    });

    expect(rowCount).toBe(0);
  });

  it('does not let the tenant setting survive its transaction', async () => {
    // `SET LOCAL` semantics are what stop a pooled connection carrying one request's tenant
    // into the next. Asserting it here means a change from `SET LOCAL` to `SET` fails loudly.
    await asTenant(client, NORTHWIND.tenantId, async () => {
      /* the transaction sets and then rolls back */
    });

    const { rows } = await client.query<{ tenant: string | null }>(
      'SELECT app_current_tenant_id()::text AS tenant',
    );
    expect(rows[0]?.tenant).toBeNull();
  });
});

describe('every tenant-scoped table is actually protected', () => {
  it('has RLS enabled and forced on all of them', async () => {
    // The failure this catches is the quiet one: a table added in a later phase that nobody
    // remembers to attach a policy to. It reads the catalogue rather than trusting the
    // migration, so the assertion is about the database's real state.
    const { rows } = await client.query<{
      tablename: string;
      rowsecurity: boolean;
      forced: boolean;
    }>(
      `SELECT c.relname AS tablename, c.relrowsecurity AS rowsecurity, c.relforcerowsecurity AS forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );

    const unprotected = rows
      .filter((row) => !row.rowsecurity || !row.forced)
      .map((row) => row.tablename)
      // Atlas's own bookkeeping table is not tenant data and is never read by the application.
      .filter((name) => name !== 'atlas_schema_revisions')
      .sort();

    expect(unprotected).toEqual([]);
  });

  it('covers every table with a tenant_isolation policy for all commands', async () => {
    const { rows } = await client.query<{ tablename: string; cmd: string }>(
      `SELECT tablename, cmd FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'tenant_isolation'`,
    );

    expect(rows.map((row) => row.tablename).sort()).toEqual([...TENANT_SCOPED_TABLES].sort());
    expect([...new Set(rows.map((row) => row.cmd))]).toEqual(['ALL']);
  });

  it('gives the application role no way to bypass them', async () => {
    const { rows } = await client.query<{ bypass: boolean; login: boolean; superuser: boolean }>(
      `SELECT rolbypassrls AS bypass, rolcanlogin AS login, rolsuper AS superuser
         FROM pg_roles WHERE rolname = 'wispr_app'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.bypass).toBe(false);
    expect(rows[0]?.superuser).toBe(false);
    // NOLOGIN: reached only via SET ROLE from an authenticated connection, so there is no
    // password for this role and therefore none to commit.
    expect(rows[0]?.login).toBe(false);
  });
});
