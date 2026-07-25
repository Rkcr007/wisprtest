import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runWithContext } from '../../src/context/request-context.js';
import { listApplications, listUsers } from '../../src/db/repositories.js';
import { TenantContextMissingError } from '../../src/errors.js';
import { NEIGHBOUR, SEED, startHarness, type Harness } from '../support/harness.js';

/**
 * Tenancy, from the HTTP edge all the way to the row.
 *
 * Phase 3 proved the database enforces isolation when a connection is scoped correctly. This
 * proves the gateway scopes it — that a request authenticated as one tenant cannot read another
 * one's rows through the repository layer, and that a code path which skips authentication
 * cannot reach the database at all.
 */

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness({
    routes: (app) => {
      app.get('/test/applications', () =>
        harness.database.withTenant('list-applications', async (db) => ({
          names: (await listApplications(db)).map((row) => row.name),
        })),
      );
      app.get('/test/users', () =>
        harness.database.withTenant('list-users', async (db) => ({
          emails: (await listUsers(db)).map((row) => row.email),
        })),
      );
    },
  });
});

afterAll(async () => {
  await harness.close();
});

async function asUser(email: string, path: string) {
  const token = await harness.issuer.sign({ email });
  return harness.app.inject({
    method: 'GET',
    url: path,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('a request sees only its own tenant', () => {
  it('lists the applications of the authenticated tenant', async () => {
    const response = await asUser(SEED.leadEmail, '/test/applications');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ names: ['Northwind Orders'] });
  });

  it('shows the neighbouring tenant its own row of the same name', async () => {
    // Both seed tenants own an application called "Northwind Orders". Each sees exactly one,
    // and it is theirs — the case a `where name = …` without a tenant filter would get wrong.
    const response = await asUser(NEIGHBOUR.ownerEmail, '/test/applications');

    expect(response.json()).toEqual({ names: ['Northwind Orders'] });
  });

  it('never returns another tenant’s users', async () => {
    const response = await asUser(SEED.leadEmail, '/test/users');
    const { emails } = response.json<{ emails: string[] }>();

    expect(emails.sort()).toEqual([SEED.testerEmail, SEED.leadEmail].sort());
    expect(emails.some((email) => email.endsWith('@contoso.example'))).toBe(false);
  });

  it('does so without any repository writing a tenant filter', () => {
    // `listApplications` is `selectFrom('applications').selectAll()` — no where clause at all.
    // The scoping is the database's, applied by the policy from Phase 3. A duplicated filter in
    // application code would be one more thing that can drift out of step with the policy.
    const source = listApplications.toString();
    expect(source).not.toContain('tenant');
  });
});

describe('the database is unreachable without a tenant', () => {
  it('refuses a query issued with no request context at all', async () => {
    // The shape of a background job, a stray import, or a handler that skipped auth.
    await expect(
      harness.database.withTenant('no-context', (db) => listApplications(db)),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
  });

  it('names the operation, so the failure points at the code path that skipped auth', async () => {
    await expect(
      harness.database.withTenant('suspicious-operation', (db) => listUsers(db)),
    ).rejects.toThrow(/suspicious-operation/);
  });

  it('does not take a pooled connection when it is going to refuse', async () => {
    // A checkout that is certain to fail should fail before it takes a connection other
    // requests are queued for. Ten refusals in a row against a pool this size would exhaust it
    // if each one grabbed a connection first.
    for (let i = 0; i < 10; i += 1) {
      await expect(
        harness.database.withTenant('drain-check', () => Promise.resolve(1)),
      ).rejects.toThrow();
    }

    // The pool is still healthy afterwards.
    const response = await asUser(SEED.leadEmail, '/test/applications');
    expect(response.statusCode).toBe(200);
  });

  it('scopes to whatever tenant the ambient context names', async () => {
    // The mechanism itself, without HTTP in the way: the same call in two contexts reads two
    // different tenants' rows.
    const ours = await runWithContext(
      {
        tenantId: SEED.tenantId,
        userId: null,
        role: null,
        sessionId: null,
        traceId: 'test',
        requestId: 'test',
      },
      () => harness.database.withTenant('scoped-read', (db) => listApplications(db)),
    );

    const theirs = await runWithContext(
      {
        tenantId: NEIGHBOUR.tenantId,
        userId: null,
        role: null,
        sessionId: null,
        traceId: 'test',
        requestId: 'test',
      },
      () => harness.database.withTenant('scoped-read', (db) => listApplications(db)),
    );

    expect(ours).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(ours[0]?.id).not.toBe(theirs[0]?.id);
    expect(ours[0]?.tenantId).toBe(SEED.tenantId);
    expect(theirs[0]?.tenantId).toBe(NEIGHBOUR.tenantId);
  });

  it('leaves no tenant setting behind on the pooled connection', async () => {
    // `SET LOCAL` and `set_config(…, true)` are transaction-scoped precisely so a connection
    // returned to the pool carries nothing into the next request. If either became session
    // scoped, this read would still see a tenant.
    await runWithContext(
      {
        tenantId: SEED.tenantId,
        userId: null,
        role: null,
        sessionId: null,
        traceId: 'test',
        requestId: 'test',
      },
      () => harness.database.withTenant('scoped-read', (db) => listApplications(db)),
    );

    const leaked = await harness.database.unscoped('readiness-probe', async (db) => {
      const result = await db
        .selectNoFrom((eb) => eb.fn<string | null>('app_current_tenant_id').as('tenant'))
        .executeTakeFirst();
      return result?.tenant ?? null;
    });

    expect(leaked).toBeNull();
  });
});
