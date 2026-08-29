import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PERMISSIONS_BY_ROLE } from '../../src/rbac/permissions.js';
import { NEIGHBOUR, SEED, startHarness, type Harness } from '../support/harness.js';

/**
 * Owner-only administration against the seed tenant.
 *
 * The fixture has no owner. These tests promote the lead for the duration of the file and put
 * both users back. A leftover owner would change every later suite that expects Priya to be a
 * lead — restore is part of the contract, not cleanup.
 */

const LEAD_ID = '22222222-2222-4222-8222-222222222221';
const TESTER_ID = '22222222-2222-4222-8222-222222222222';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
  await harness.database.unscoped('readiness-probe', async (db) => {
    await db.updateTable('users').set({ role: 'owner' }).where('id', '=', LEAD_ID).execute();
  });
});

afterAll(async () => {
  await harness.database.unscoped('readiness-probe', async (db) => {
    await db.updateTable('users').set({ role: 'lead' }).where('id', '=', LEAD_ID).execute();
    await db.updateTable('users').set({ role: 'tester' }).where('id', '=', TESTER_ID).execute();
    await db.deleteFrom('auditLog').where('action', '=', 'user.role_changed').execute();
  });
  await harness.close();
});

async function get(email: string, url: string) {
  const token = await harness.issuer.sign({ email });
  return harness.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function patch(email: string, url: string, body: Record<string, unknown>) {
  const token = await harness.issuer.sign({ email });
  return harness.app.inject({
    method: 'PATCH',
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: body,
  });
}

describe('GET /v1/admin/users', () => {
  it('is owner-only and lists this tenant only', async () => {
    const asTester = await get(SEED.testerEmail, '/v1/admin/users');
    expect(asTester.statusCode).toBe(403);

    const ours = await get(SEED.leadEmail, '/v1/admin/users');
    expect(ours.statusCode).toBe(200);
    const listed = ours.json() as { users: { id: string; email: string; role: string }[] };
    expect(listed.users.map((row) => row.email)).toEqual(
      expect.arrayContaining([SEED.leadEmail, SEED.testerEmail]),
    );
    expect(listed.users.map((row) => row.email)).not.toContain(NEIGHBOUR.ownerEmail);

    const theirs = await get(NEIGHBOUR.ownerEmail, '/v1/admin/users');
    expect(theirs.statusCode).toBe(200);
    const neighbour = theirs.json() as { users: { email: string }[] };
    expect(neighbour.users.map((row) => row.email)).toContain(NEIGHBOUR.ownerEmail);
    expect(neighbour.users.map((row) => row.email)).not.toContain(SEED.leadEmail);
  });
});

describe('PATCH /v1/admin/users/:id', () => {
  it('changes a role, audits it, and refuses demoting the last owner', async () => {
    const changed = await patch(SEED.leadEmail, `/v1/admin/users/${TESTER_ID}`, { role: 'viewer' });
    expect(changed.statusCode).toBe(200);
    expect((changed.json() as { role: string }).role).toBe('viewer');

    const lastOwner = await patch(SEED.leadEmail, `/v1/admin/users/${LEAD_ID}`, { role: 'lead' });
    expect(lastOwner.statusCode).toBe(400);
    expect((lastOwner.json() as { code: string }).code).toBe('validation_failed');

    const restored = await patch(SEED.leadEmail, `/v1/admin/users/${TESTER_ID}`, { role: 'tester' });
    expect(restored.statusCode).toBe(200);
    expect((restored.json() as { role: string }).role).toBe('tester');
  });
});

describe('GET /v1/admin/policy', () => {
  it('returns the RBAC matrix and the frozen reversibility taxonomy', async () => {
    const response = await get(SEED.leadEmail, '/v1/admin/policy');
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      writable: boolean;
      permissionsByRole: typeof PERMISSIONS_BY_ROLE;
      reversibility: { class: string; speculative: boolean }[];
      redaction: { writable: boolean; elementTextInLogs: boolean };
    };
    expect(body.writable).toBe(false);
    expect(body.permissionsByRole.owner).toEqual([...PERMISSIONS_BY_ROLE.owner]);
    expect(body.reversibility.find((row) => row.class === 'C')?.speculative).toBe(false);
    expect(body.reversibility.find((row) => row.class === 'S')?.speculative).toBe(false);
    expect(body.redaction.writable).toBe(false);
    expect(body.redaction.elementTextInLogs).toBe(false);
  });
});

describe('GET /v1/admin/audit', () => {
  it('pages tenant audit rows including the role change just made', async () => {
    const response = await get(SEED.leadEmail, '/v1/admin/audit?limit=50');
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      entries: { action: string; target: string }[];
      total: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.entries.some((row) => row.action === 'user.role_changed')).toBe(true);
    expect(body.entries.some((row) => row.target === `user:${TESTER_ID}`)).toBe(true);
  });
});
