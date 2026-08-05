import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { Client } from 'pg';
import {
  DriftListResponse,
  DriftRaiseResponse,
  DriftDecisionResponse,
  DriftReconcileJob,
  Session,
} from 'protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { NEIGHBOUR, SEED, startHarness, type Harness } from '../support/harness.js';

/**
 * The drift routes, against the real stack.
 *
 * docs/BUILD-PLAN.md Phase 17's gateway half. Postgres and Redis are the Compose ones; the
 * indexer is scripted, because a reconcile opens a browser for tens of seconds and what is under
 * test here is what the gateway does with a reconciled report, not how one is produced.
 *
 * The properties this suite exists to hold:
 *
 * - **Drift never blocks the tester.** Raising is cheap, and a Redis outage costs a report its
 *   reconcile job, not the tester their request.
 * - **A repeat sighting is not a repeat report.** A tester settling on a drifted screen raises on
 *   every settle; that is one fact, not forty.
 * - **Nothing becomes active without a human.** Not an unreconciled report, not a second approval,
 *   and there is no request shape that means "approve automatically".
 * - **Activation is atomic.** There is never an instant with no active version, because a snapshot
 *   load landing in it would tell a tester their application was never indexed.
 * - **A tester's vocabulary is carried across, and what is lost is counted.**
 */

let harness: Harness;
let client: Client;
let reader: Redis;

let screenId: string;
let candidateVersionId: string;
let candidateScreenId: string;
let elementId: string;
let candidateElementId: string;

/** `orders.filter.pending` on the seeded version — the screen these reports are about. */
const SEEDED_SCREEN = '55555555-5555-4555-8555-555555555551';
const SEEDED_ELEMENT = '66666666-6666-4666-8666-666666666661';

/** Well clear of anything the fixtures or a crawl would mint. */
const CANDIDATE_VERSION = 900;

/** Phrases this suite inserts, and the only aliases it is allowed to remove. */
const OWNED_PHRASES = ['pending ones', 'wipe everything'];

/** The screen whose element the candidate version does not have. Cleaned up in `beforeEach`. */
const ORPHAN_FINGERPRINT = 'f'.repeat(64);

const EXPECTED_HASH = 'b'.repeat(64);
const OBSERVED_HASH = 'c'.repeat(64);

const FINGERPRINT = {
  role: 'button',
  tagName: 'button',
  accessibleNameHash: 'c'.repeat(64),
  accessibleNameRedacted: 'Pending',
  landmarkPath: ['main', 'region:orders'],
  stableAttributes: { 'data-testid': 'filter-pending' },
  ordinal: 0,
  textShingleHash: 'd'.repeat(64),
  bbox: { x: 0.1, y: 0.2, width: 0.12, height: 0.04 },
};

beforeAll(async () => {
  harness = await startHarness({});

  client = new Client({ connectionString: harness.config.DATABASE_URL });
  await client.connect();

  // Read the reconcile stream the way the indexer would: its own connection, no `keyPrefix`,
  // because that is how the indexer's client is configured. A double that duplicated the
  // gateway's prefixed client would read `wispr:wispr:…` and see nothing, which is the exact
  // mismatch this assertion is here to catch.
  reader = new Redis(harness.config.REDIS_URL, { lazyConnect: false });

  screenId = SEEDED_SCREEN;
  elementId = SEEDED_ELEMENT;

  // Idempotent setup. A run that failed part-way leaves its candidate version behind, and the
  // next run would collide on `memory_versions_application_version_key` in a way that reads like
  // a product bug rather than leftover state.
  await client.query('DELETE FROM drift_reports WHERE tenant_id = $1', [SEED.tenantId]);
  await client.query('DELETE FROM aliases WHERE phrase = ANY($1)', [OWNED_PHRASES]);
  await client.query(`DELETE FROM memory_versions WHERE application_id = $1 AND version = $2`, [
    SEED.applicationId,
    CANDIDATE_VERSION,
  ]);
  await client.query(`UPDATE memory_versions SET status = 'active' WHERE id = $1`, [
    SEED.memoryVersionId,
  ]);

  // A candidate version, as a reconcile would have left it: cloned from the active one, holding
  // the same screen by state fingerprint and the same element by key, and still `building`.
  const candidate = await client.query<{ id: string }>(
    `INSERT INTO memory_versions (tenant_id, application_id, version, status)
     VALUES ($1, $2, $3, 'building') RETURNING id`,
    [SEED.tenantId, SEED.applicationId, CANDIDATE_VERSION],
  );
  candidateVersionId = candidate.rows[0]?.id ?? '';

  const cloned = await client.query<{ id: string }>(
    `INSERT INTO screens (tenant_id, memory_version_id, route_pattern, state_fingerprint, label, structural_hash)
     SELECT tenant_id, $1, route_pattern, state_fingerprint, label, $2
       FROM screens WHERE id = $3
     RETURNING id`,
    [candidateVersionId, OBSERVED_HASH, SEEDED_SCREEN],
  );
  candidateScreenId = cloned.rows[0]?.id ?? '';

  const clonedElement = await client.query<{ id: string }>(
    `INSERT INTO elements (tenant_id, screen_id, element_key, role, accessible_name_hash, fingerprint, confidence, stability)
     VALUES ($1, $2, 'orders.filter.pending', 'button', $3, $4, 0.97, 0.91)
     RETURNING id`,
    [SEED.tenantId, candidateScreenId, 'c'.repeat(64), JSON.stringify(FINGERPRINT)],
  );
  candidateElementId = clonedElement.rows[0]?.id ?? '';
}, 60_000);

afterAll(async () => {
  // Reports first. `candidate_memory_version_id` is ON DELETE SET NULL, and nulling it under a
  // `diffed` report violates the CHECK that a reconciled report must name something to activate —
  // so the database refuses to orphan a pending decision. Correct, and it means anything deleting
  // a memory version has to resolve the reports depending on it first.
  await client.query('DELETE FROM drift_reports WHERE tenant_id = $1', [SEED.tenantId]);
  await client.query('DELETE FROM memory_versions WHERE id = $1', [candidateVersionId]);
  await client.end();
  reader.disconnect();
  await harness.close();
});

beforeEach(async () => {
  // Only what this suite creates. `db/seed/001_fixture.sql` owns an alias on the seeded version
  // and other suites assert against it — a blanket `DELETE FROM aliases WHERE tenant_id` here
  // passes locally and then fails `test:db` on the *next* run, which is a miserable thing to
  // debug because the suite that broke is not the suite that failed.
  await client.query('DELETE FROM drift_reports WHERE tenant_id = $1', [SEED.tenantId]);
  await client.query('DELETE FROM aliases WHERE phrase = ANY($1) OR memory_version_id = $2', [
    OWNED_PHRASES,
    candidateVersionId,
  ]);
  await client.query(
    `UPDATE memory_versions SET status = 'building', approved_by = NULL WHERE id = $1`,
    [candidateVersionId],
  );
  await client.query(`UPDATE memory_versions SET status = 'active' WHERE id = $1`, [
    SEED.memoryVersionId,
  ]);
  // Removed here rather than at the end of the test that creates it: cleanup written into a test
  // body does not run when that test fails, and the leftover then breaks the *next* run with a
  // unique-constraint error that has nothing to do with what actually went wrong.
  await client.query('DELETE FROM screens WHERE state_fingerprint = $1', [ORPHAN_FINGERPRINT]);
  await reader.del('wispr:indexer:drift');
});

async function authed(email: string) {
  const token = await harness.issuer.sign({ email });
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function openSession(): Promise<string> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: await authed(SEED.testerEmail),
    payload: JSON.stringify({
      applicationId: SEED.applicationId,
      memoryVersionId: SEED.memoryVersionId,
    }),
  });
  expect(response.statusCode).toBe(201);
  return Session.parse(response.json()).id;
}

async function raise(
  sessionId: string,
  overrides: Record<string, unknown> = {},
  email: string = SEED.testerEmail,
) {
  return harness.app.inject({
    method: 'POST',
    url: '/v1/drift',
    headers: await authed(email),
    payload: JSON.stringify({
      sessionId,
      screenId,
      routePattern: '/orders',
      route: '/orders',
      stateFingerprint: 'a'.repeat(64),
      expectedStructuralHash: EXPECTED_HASH,
      observedStructuralHash: OBSERVED_HASH,
      observedAt: new Date().toISOString(),
      ...overrides,
    }),
  });
}

/** Move a report to the state a finished reconcile leaves it in. */
async function reconciled(reportId: string): Promise<void> {
  await client.query(
    `UPDATE drift_reports
        SET status = 'diffed', candidate_memory_version_id = $2, alias_migration_rate = 0.9,
            diff = $3
      WHERE id = $1`,
    [
      reportId,
      candidateVersionId,
      JSON.stringify({ added: [], removed: [], moved: [], renamed: [], schemaChanges: [] }),
    ],
  );
}

async function decide(reportId: string, body: unknown, email: string = SEED.leadEmail) {
  return harness.app.inject({
    method: 'POST',
    url: `/v1/drift/${reportId}/approve`,
    headers: await authed(email),
    payload: JSON.stringify(body),
  });
}

describe('raising a report', () => {
  it('creates one, and puts a reconcile on the stream the indexer reads', async () => {
    const sessionId = await openSession();
    const response = await raise(sessionId);

    expect(response.statusCode).toBe(201);
    const body = DriftRaiseResponse.parse(response.json());
    expect(body.created).toBe(true);
    expect(body.report.status).toBe('open');
    // The version is the session's, never the caller's.
    expect(body.report.memoryVersionId).toBe(SEED.memoryVersionId);
    // Nothing has reconciled it, so there is nothing an approval could activate.
    expect(body.report.candidateMemoryVersionId).toBeNull();
    expect(body.report.observedRoute).toBe('/orders');

    const entries = await reader.xrange('wispr:indexer:drift', '-', '+');
    expect(entries).toHaveLength(1);
    const raw = entries[0]?.[1]?.[1] ?? '';
    const job = DriftReconcileJob.parse(JSON.parse(raw));
    expect(job.driftReportId).toBe(body.report.id);
    // A pattern cannot be navigated to; the concrete path is what the worker gets.
    expect(job.route).toBe('/orders');
    expect(job.memoryVersionId).toBe(SEED.memoryVersionId);
  });

  it('treats a repeat sighting as the same fact', async () => {
    const sessionId = await openSession();

    const first = DriftRaiseResponse.parse((await raise(sessionId)).json());
    const second = await raise(sessionId);

    expect(second.statusCode).toBe(200);
    const body = DriftRaiseResponse.parse(second.json());
    expect(body.created).toBe(false);
    expect(body.report.id).toBe(first.report.id);

    // One report, and — just as importantly — one reconcile. A tester settling on a drifted
    // screen forty times must not queue forty browser sessions.
    const rows = await client.query('SELECT id FROM drift_reports WHERE tenant_id = $1', [
      SEED.tenantId,
    ]);
    expect(rows.rowCount).toBe(1);
    expect(await reader.xrange('wispr:indexer:drift', '-', '+')).toHaveLength(1);
  });

  it('raises a second report when the page drifts again to a different hash', async () => {
    const sessionId = await openSession();
    await raise(sessionId);

    const again = await raise(sessionId, { observedStructuralHash: 'e'.repeat(64) });

    expect(again.statusCode).toBe(201);
    // A different observed hash is a different change: the candidate the first reconcile built no
    // longer describes what is live, and a human needs to see both.
    expect(DriftRaiseResponse.parse(again.json()).created).toBe(true);
  });

  it('refuses a report whose hashes agree', async () => {
    const sessionId = await openSession();
    const response = await raise(sessionId, { observedStructuralHash: EXPECTED_HASH });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a screen that does not belong to the session’s memory version', async () => {
    const sessionId = await openSession();
    const response = await raise(sessionId, { screenId: randomUUID() });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('screen');
  });
});

describe('the review queue', () => {
  it('lists pending reports for an application and hides decided ones', async () => {
    const sessionId = await openSession();
    const raised = DriftRaiseResponse.parse((await raise(sessionId)).json());

    const before = DriftListResponse.parse(
      (
        await harness.app.inject({
          method: 'GET',
          url: `/v1/drift/${SEED.applicationId}`,
          headers: await authed(SEED.testerEmail),
        })
      ).json(),
    );
    expect(before.total).toBe(1);
    expect(before.reports[0]?.id).toBe(raised.report.id);

    await reconciled(raised.report.id);
    await decide(raised.report.id, { decision: 'reject', reason: 'mid-deploy; re-index instead' });

    const after = DriftListResponse.parse(
      (
        await harness.app.inject({
          method: 'GET',
          url: `/v1/drift/${SEED.applicationId}`,
          headers: await authed(SEED.testerEmail),
        })
      ).json(),
    );
    expect(after.total).toBe(0);
  });

  it('never shows another tenant’s reports', async () => {
    const sessionId = await openSession();
    await raise(sessionId);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/drift/${NEIGHBOUR.applicationId}`,
      headers: await authed(SEED.testerEmail),
    });

    // Row-level security, not a filter in the query. The neighbour's application is invisible,
    // so the queue is empty rather than forbidden.
    expect(response.statusCode).toBe(200);
    expect(DriftListResponse.parse(response.json()).total).toBe(0);
  });
});

describe('deciding', () => {
  it('activates the reconciled version and supersedes the old one, in one step', async () => {
    const sessionId = await openSession();
    const raised = DriftRaiseResponse.parse((await raise(sessionId)).json());
    await reconciled(raised.report.id);

    const response = await decide(raised.report.id, { decision: 'approve' });

    expect(response.statusCode).toBe(200);
    const body = DriftDecisionResponse.parse(response.json());
    expect(body.report.status).toBe('approved');
    expect(body.newMemoryVersionId).toBe(candidateVersionId);

    const versions = await client.query<{ id: string; status: string; approved_by: string | null }>(
      'SELECT id, status, approved_by FROM memory_versions WHERE id = ANY($1)',
      [[SEED.memoryVersionId, candidateVersionId]],
    );
    const byId = new Map(versions.rows.map((row) => [row.id, row]));
    expect(byId.get(candidateVersionId)?.status).toBe('active');
    expect(byId.get(candidateVersionId)?.approved_by).not.toBeNull();
    expect(byId.get(SEED.memoryVersionId)?.status).toBe('superseded');

    // Exactly one active version at every point a reader could observe. The partial unique index
    // guarantees it, and this asserts the transaction did not have to violate it on the way.
    const active = await client.query(
      `SELECT id FROM memory_versions WHERE application_id = $1 AND status = 'active'`,
      [SEED.applicationId],
    );
    expect(active.rowCount).toBe(1);
  });

  it('carries a tester’s vocabulary across, and counts what it could not', async () => {
    // Two aliases: one on an element the candidate version still has, one on an element it does
    // not. The second is the case a lead needs to know about before approving.
    await client.query(
      `INSERT INTO aliases (tenant_id, memory_version_id, phrase, element_id, source, hits)
       VALUES ($1, $2, 'pending ones', $3, 't2_writeback', 12)`,
      [SEED.tenantId, SEED.memoryVersionId, elementId],
    );

    const orphanScreen = await client.query<{ id: string }>(
      `INSERT INTO screens (tenant_id, memory_version_id, route_pattern, state_fingerprint, label, structural_hash)
       VALUES ($1, $2, '/settings', $3, 'Settings', $4) RETURNING id`,
      [SEED.tenantId, SEED.memoryVersionId, ORPHAN_FINGERPRINT, 'a'.repeat(64)],
    );
    const orphanElement = await client.query<{ id: string }>(
      `INSERT INTO elements (tenant_id, screen_id, element_key, role, accessible_name_hash, fingerprint, confidence, stability)
       VALUES ($1, $2, 'settings.form.purge', 'button', $3, $4, 0.9, 0.9) RETURNING id`,
      [SEED.tenantId, orphanScreen.rows[0]?.id, 'e'.repeat(64), JSON.stringify(FINGERPRINT)],
    );
    await client.query(
      `INSERT INTO aliases (tenant_id, memory_version_id, phrase, element_id, source, hits)
       VALUES ($1, $2, 'wipe everything', $3, 'manual', 3)`,
      [SEED.tenantId, SEED.memoryVersionId, orphanElement.rows[0]?.id],
    );

    const sessionId = await openSession();
    const raised = DriftRaiseResponse.parse((await raise(sessionId)).json());
    await reconciled(raised.report.id);

    const body = DriftDecisionResponse.parse(
      (await decide(raised.report.id, { decision: 'approve' })).json(),
    );

    // Asserted as the rule rather than as arithmetic. The seeded fixture owns an alias on this
    // version too, and it migrates for exactly the same reason `pending ones` does — so pinning
    // a total here would be pinning how many rows some other file happens to insert.
    expect(body.aliasMigration?.dropped).toBe(1);
    expect(body.aliasMigration?.migrated).toBeGreaterThanOrEqual(1);

    // Migrated by `(state_fingerprint, element_key)`, not by element id — the candidate's rows
    // are new rows, so nothing could have been carried by pointer.
    const carried = await client.query<{ phrase: string; element_id: string; hits: number }>(
      'SELECT phrase, element_id, hits FROM aliases WHERE memory_version_id = $1',
      [candidateVersionId],
    );
    const byPhrase = new Map(carried.rows.map((row) => [row.phrase, row]));

    expect(byPhrase.get('pending ones')?.element_id).toBe(candidateElementId);
    // The hit count is the evidence the alias earned its place; resetting it would throw away
    // the compounding loop's record of what actually works.
    expect(Number(byPhrase.get('pending ones')?.hits)).toBe(12);
    // The one whose element is gone from the candidate version. Dropped, and counted above —
    // never silently carried onto some other element that happened to score well.
    expect(byPhrase.has('wipe everything')).toBe(false);
  });

  it('refuses to approve a report nobody has reconciled', async () => {
    const sessionId = await openSession();
    const raised = DriftRaiseResponse.parse((await raise(sessionId)).json());

    const response = await decide(raised.report.id, { decision: 'approve' });

    // There is nothing to activate. Reporting success here would leave the application on the
    // memory the tester already knows is wrong, while telling them it was fixed.
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('not been reconciled');

    const version = await client.query<{ status: string }>(
      'SELECT status FROM memory_versions WHERE id = $1',
      [candidateVersionId],
    );
    expect(version.rows[0]?.status).toBe('building');
  });

  it('records a rejection with its reason, and leaves the candidate alone', async () => {
    const sessionId = await openSession();
    const raised = DriftRaiseResponse.parse((await raise(sessionId)).json());
    await reconciled(raised.report.id);

    const body = DriftDecisionResponse.parse(
      (
        await decide(raised.report.id, {
          decision: 'reject',
          reason: 'the create form was mid-deploy; re-index instead',
        })
      ).json(),
    );

    expect(body.report.status).toBe('rejected');
    expect(body.newMemoryVersionId).toBeNull();
    expect(body.aliasMigration).toBeNull();

    // The candidate is evidence of what was proposed, and costs nothing while inactive.
    const version = await client.query<{ status: string }>(
      'SELECT status FROM memory_versions WHERE id = $1',
      [candidateVersionId],
    );
    expect(version.rows[0]?.status).toBe('building');

    const audit = await client.query<{ metadata: { reason: string } }>(
      `SELECT metadata FROM audit_log WHERE tenant_id = $1 AND action = 'drift.rejected'
        ORDER BY created_at DESC LIMIT 1`,
      [SEED.tenantId],
    );
    expect(audit.rows[0]?.metadata.reason).toBe('the create form was mid-deploy; re-index instead');
  });

  it('will not decide the same report twice', async () => {
    const sessionId = await openSession();
    const raised = DriftRaiseResponse.parse((await raise(sessionId)).json());
    await reconciled(raised.report.id);

    expect((await decide(raised.report.id, { decision: 'approve' })).statusCode).toBe(200);
    const second = await decide(raised.report.id, { decision: 'approve' });

    expect(second.statusCode).toBe(400);
    expect(JSON.stringify(second.json())).toContain('already');
  });

  it('refuses a tester, because approving memory is a lead’s decision', async () => {
    const sessionId = await openSession();
    const raised = DriftRaiseResponse.parse((await raise(sessionId)).json());
    await reconciled(raised.report.id);

    const response = await decide(raised.report.id, { decision: 'approve' }, SEED.testerEmail);

    expect(response.statusCode).toBe(403);
  });

  it('has no request shape that means approve automatically', async () => {
    const sessionId = await openSession();
    const raised = DriftRaiseResponse.parse((await raise(sessionId)).json());
    await reconciled(raised.report.id);

    // ADR 0007 and BUILD-PLAN Phase 17: "Do not add an auto-approve path, even behind a flag."
    // The contract has two decisions and no third, so this is a schema rejection rather than a
    // policy check somebody could later relax.
    for (const body of [
      { decision: 'auto_approve' },
      { decision: 'approve', auto: true },
      { decision: 'reject' },
    ]) {
      expect((await decide(raised.report.id, body)).statusCode).toBe(400);
    }

    const version = await client.query<{ status: string }>(
      'SELECT status FROM memory_versions WHERE id = $1',
      [candidateVersionId],
    );
    expect(version.rows[0]?.status).toBe('building');
  });
});
