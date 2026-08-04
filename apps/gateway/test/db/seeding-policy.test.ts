import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connect, NORTHWIND } from './support.js';

/**
 * The per-application seeding policy, enforced by the database.
 *
 * docs/TEST-DATA-ENGINE.md § 7 requires seeding into a production environment to be "blocked by
 * policy unless explicitly and auditably enabled". `/v1/seed/execute` refuses on this column, but
 * the route is not where the guarantee lives: a second caller — the console's admin screen, a
 * migration, a support script — would each have to reimplement the rule, and the one that got it
 * wrong would write to a customer's production system.
 *
 * So the rule is a generated column, and these are the assertions that it means what the route
 * believes it means.
 */

let client: Client;

/** Ids used only here, so a failing assertion names a row that belongs to this file. */
const PROD_APP = '5eed0000-0000-4000-8000-000000000001';
const STAGE_APP = '5eed0000-0000-4000-8000-000000000002';

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

/**
 * Run `work` against two freshly inserted applications, then roll back.
 *
 * The migration user rather than `wispr_app`: this file is about CHECK constraints and a
 * generated column, which apply to every role. Tenant isolation is `rls.test.ts`'s subject.
 */
async function withApplications<T>(work: (client: Client) => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO applications (id, tenant_id, name, base_url, env) VALUES
         ($1, $3, 'Policy fixture — production', 'https://prod.example', 'production'),
         ($2, $3, 'Policy fixture — staging',    'https://stage.example', 'staging')`,
      [PROD_APP, STAGE_APP, NORTHWIND.tenantId],
    );
    return await work(client);
  } finally {
    await client.query('ROLLBACK');
  }
}

async function seedingAllowed(applicationId: string): Promise<boolean> {
  const { rows } = await client.query<{ allowed: boolean }>(
    'SELECT seeding_allowed AS allowed FROM applications WHERE id = $1',
    [applicationId],
  );
  const allowed = rows[0]?.allowed;
  if (allowed === undefined) throw new Error(`no application ${applicationId}`);
  return allowed;
}

async function enableSeeding(applicationId: string, reason: string): Promise<void> {
  await client.query(
    `UPDATE applications
        SET seeding_enabled_at = now(), seeding_enabled_by = $2, seeding_enabled_reason = $3
      WHERE id = $1`,
    [applicationId, NORTHWIND.leadUserId, reason],
  );
}

describe('the default is what the environment says', () => {
  it('blocks a production application nobody has opted in', async () => {
    await withApplications(async () => {
      expect(await seedingAllowed(PROD_APP)).toBe(false);
    });
  });

  it('allows every other environment without ceremony', async () => {
    await withApplications(async () => {
      expect(await seedingAllowed(STAGE_APP)).toBe(true);
    });
  });
});

describe('enabling production', () => {
  it('takes effect as soon as the policy is recorded', async () => {
    await withApplications(async () => {
      await enableSeeding(PROD_APP, 'isolated sandbox tenant, signed off by platform');
      expect(await seedingAllowed(PROD_APP)).toBe(true);
    });
  });

  it('refuses an enablement with no stated justification', async () => {
    await withApplications(async (db) => {
      await expect(
        db.query('UPDATE applications SET seeding_enabled_at = now() WHERE id = $1', [PROD_APP]),
      ).rejects.toThrow(/applications_seeding_policy_complete/);
    });
  });

  it('refuses a justification of whitespace', async () => {
    await withApplications(async (db) => {
      await expect(
        db.query(
          `UPDATE applications
              SET seeding_enabled_at = now(), seeding_enabled_by = $2, seeding_enabled_reason = '   '
            WHERE id = $1`,
          [PROD_APP, NORTHWIND.leadUserId],
        ),
      ).rejects.toThrow(/applications_seeding_reason_check/);
    });
  });

  it('refuses an approver attached to no enablement', async () => {
    await withApplications(async (db) => {
      await expect(
        db.query('UPDATE applications SET seeding_enabled_by = $2 WHERE id = $1', [
          PROD_APP,
          NORTHWIND.leadUserId,
        ]),
      ).rejects.toThrow(/applications_seeding_policy_complete/);
    });
  });

  it('refuses an approver from another tenant', async () => {
    await withApplications(async (db) => {
      await db.query(
        `INSERT INTO tenants (id, name) VALUES ('5eed0000-0000-4000-8000-00000000000a', 'Neighbour')`,
      );
      await db.query(
        `INSERT INTO users (id, tenant_id, email, role)
         VALUES ('5eed0000-0000-4000-8000-00000000000b', '5eed0000-0000-4000-8000-00000000000a',
                 'outsider@neighbour.example', 'lead')`,
      );

      await expect(
        db.query(
          `UPDATE applications
              SET seeding_enabled_at = now(),
                  seeding_enabled_by = '5eed0000-0000-4000-8000-00000000000b',
                  seeding_enabled_reason = 'approved by somebody else entirely'
            WHERE id = $1`,
          [PROD_APP],
        ),
      ).rejects.toThrow(/applications_seeding_enabled_by_fkey/);
    });
  });
});

/**
 * The policy has to outlive the person who set it.
 *
 * An approver's account being deleted must not fail, and must not silently re-block a production
 * application that a platform team deliberately opened — a tester finding out that seeding stopped
 * working because somebody left the company is a support ticket nobody can diagnose. Who signed
 * off remains in `audit_log`, which is append-only and survives the account by design.
 */
describe('the policy outlives its approver', () => {
  it('clears the approver without failing the delete or revoking the policy', async () => {
    await withApplications(async (db) => {
      await enableSeeding(PROD_APP, 'isolated sandbox tenant, signed off by platform');
      await db.query('DELETE FROM users WHERE id = $1', [NORTHWIND.leadUserId]);

      const { rows } = await db.query<{
        allowed: boolean;
        approver: string | null;
        reason: string | null;
      }>(
        `SELECT seeding_allowed AS allowed, seeding_enabled_by AS approver,
                seeding_enabled_reason AS reason
           FROM applications WHERE id = $1`,
        [PROD_APP],
      );

      expect(rows[0]).toEqual({
        allowed: true,
        approver: null,
        reason: 'isolated sandbox tenant, signed off by platform',
      });
    });
  });
});
