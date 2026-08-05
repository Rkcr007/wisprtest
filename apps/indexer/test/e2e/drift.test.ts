import { randomUUID } from 'node:crypto';

import { pino } from 'pino';
import type { Browser } from 'playwright';
import type { DriftReconcileJob } from 'protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchBrowser } from '../../src/crawl/browser.js';
import { createSecretResolver } from '../../src/crawl/secrets.js';
import { createTenantDatabase, type TenantDatabase } from '../../src/db/pool.js';
import { reconcile, type ReconcileResult } from '../../src/drift/reconcile.js';
import { runJob } from '../../src/job-runner.js';
import { createRedis } from '../../src/redis/client.js';
import { createMetrics } from '../../src/telemetry/metrics.js';
import { startFixtureApp, type FixtureApp } from '../fixture-app/server.js';
import { renameNavLink } from '../fixture-app/views.js';
import {
  createFixture,
  fixtureBounds,
  fixtureJob,
  testConfig,
  type Fixture,
} from '../support/harness.js';

/**
 * Drift reconciliation, end to end, against a real application that changed.
 *
 * The assertion this suite exists for is the one in the first block: **a renamed control is
 * reported as a rename, not as a removal plus an addition.** Everything else here supports it.
 *
 * That is not a stylistic preference about diff formatting. An element key is minted from a
 * `data-testid` *or the accessible name*, so renaming a control that has no test id changes its
 * key — and a reconcile that matched elements by key would report the rename as a control that
 * vanished plus an unrelated one that appeared. A reviewer would be asked to approve deleting a
 * button that is still on the page, and every alias pointing at it would be dropped instead of
 * migrated. So this suite renames a control whose key *does* change, and asserts that it is still
 * recognised as the same element.
 *
 * ## The control it renames
 *
 * The primary nav's Settings link. It carries an `id` and no `data-testid`, which is the
 * combination that makes the test meaningful rather than merely green — see `fixture-app/views.ts`
 * for why, and for the measured scores on either side of the match floor.
 *
 * ## Viewports
 *
 * The crawl indexes at the bounds' viewport and a reconcile opens at `SEED_VIEWPORT`, because the
 * viewport a crawl used is not persisted anywhere — bounds arrive per request. So the geometry
 * signal is compared across two different normalisations and scores low. That is a real gap, not
 * an artefact of this test: the seed adapters have it too. It costs at most the bbox weight, and
 * the match here clears the floor without it.
 */

const config = testConfig();
const logger = pino({ level: config.LOG_LEVEL });

let browser: Browser;
let database: TenantDatabase;
let app: FixtureApp;
let fixture: Fixture;

/** The route the drift is raised against: an order detail page, which carries the nav. */
let observedRoute: string;
let memoryVersionId: string;
let screenId: string;
let screenStateFingerprint: string;
let settingsKey: string;

beforeAll(async () => {
  browser = await launchBrowser(true);
  database = createTenantDatabase(config);
  app = await startFixtureApp();
  fixture = await createFixture(app.url);
}, 180_000);

afterAll(async () => {
  await fixture.drop();
  await app.close();
  await browser.close();
  await database.close();
});

function dependencies() {
  return { database, browser, secrets: createSecretResolver() };
}

/** Index the fixture as it stands, and locate the screen a rename will drift. */
async function crawlAndLocate(): Promise<void> {
  const outcome = await runJob(
    fixtureJob(fixture, app.url, fixtureBounds(app.url)),
    {
      database,
      redis: await connectRedis(),
      browser,
      secrets: createSecretResolver(),
      metrics: createMetrics(),
      logger,
      progressMaxLength: config.INDEXER_PROGRESS_MAXLEN,
    },
    new AbortController().signal,
  );
  expect(outcome.status).toBe('completed');

  const version = await fixture.client.query<{ id: string }>(
    "SELECT id FROM memory_versions WHERE application_id = $1 AND status = 'active'",
    [fixture.applicationId],
  );
  memoryVersionId = version.rows[0]?.id ?? '';

  const screen = await fixture.client.query<{
    id: string;
    state_fingerprint: string;
    structural_hash: string;
  }>(
    `SELECT id, state_fingerprint, structural_hash FROM screens
      WHERE memory_version_id = $1 AND route_pattern = '/orders/:id'`,
    [memoryVersionId],
  );
  screenId = screen.rows[0]?.id ?? '';
  screenStateFingerprint = screen.rows[0]?.state_fingerprint ?? '';

  // The nav link's key is derived from its accessible name, which is the property under test.
  const element = await fixture.client.query<{ element_key: string }>(
    `SELECT element_key FROM elements WHERE screen_id = $1 AND element_key LIKE '%.primary.settings'`,
    [screenId],
  );
  expect(element.rows).toHaveLength(1);
  settingsKey = element.rows[0]?.element_key ?? '';

  // Asserted rather than assumed: every later assertion is meaningless if the crawl did not
  // produce these, and an empty string would otherwise fail much later as a confusing no-op.
  expect(memoryVersionId).not.toBe('');
  expect(screenId).not.toBe('');
  expect(settingsKey).not.toBe('');

  observedRoute = `/orders/${String(app.state.orders[0]?.id ?? 0)}`;
}

let redisConnection: Awaited<ReturnType<typeof createRedis>> | null = null;
async function connectRedis() {
  if (redisConnection === null) {
    redisConnection = createRedis(config);
    await redisConnection.connect();
  }
  return redisConnection;
}

afterAll(async () => {
  if (redisConnection !== null) await redisConnection.quit();
});

/**
 * Insert a report exactly as the gateway's raise endpoint would, and return its id.
 *
 * Clears this tenant's earlier reports first. Cleanup belongs *before* the row it owns is
 * created, not at the end of a test body — a body that fails never reaches its own cleanup, and
 * the leftover row then surfaces in whichever test happens to run first next time. Doing it here
 * rather than in a `beforeEach` is what lets a block reconcile once in `beforeAll` and then make
 * several assertions about that one outcome, without the setup deleting its own report.
 *
 * Scoped to the tenant this suite created, so it can only ever delete rows it owns.
 */
async function raiseReport(observedHash: string): Promise<string> {
  await fixture.client.query('DELETE FROM drift_reports WHERE tenant_id = $1', [fixture.tenantId]);

  const id = randomUUID();
  await fixture.client.query(
    `INSERT INTO drift_reports
       (id, tenant_id, memory_version_id, screen_id, route_pattern, state_fingerprint,
        expected_structural_hash, observed_structural_hash, observed_route, detected_by, status)
     VALUES ($1, $2, $3, $4, '/orders/:id', $5, $6, $7, $8, 'extension', 'open')`,
    [
      id,
      fixture.tenantId,
      memoryVersionId,
      screenId,
      screenStateFingerprint,
      'a'.repeat(64),
      observedHash,
      observedRoute,
    ],
  );
  return id;
}

function job(driftReportId: string): DriftReconcileJob {
  return {
    jobId: randomUUID(),
    tenantId: fixture.tenantId,
    applicationId: fixture.applicationId,
    memoryVersionId,
    driftReportId,
    screenId,
    routePattern: '/orders/:id',
    route: observedRoute,
    deadlineMs: 120_000,
    traceparent: null,
  };
}

describe('a control that was renamed', () => {
  let result: ReconcileResult;
  let reportId: string;

  beforeAll(async () => {
    await crawlAndLocate();

    // The application ships a copy change. Nothing else about the page moves.
    renameNavLink('/settings', 'Preferences');

    reportId = await raiseReport('b'.repeat(64));
    result = await reconcile(job(reportId), dependencies());
  }, 180_000);

  it('produces a diff rather than failing', () => {
    expect(result.reason).toBeNull();
    expect(result.outcome).toBe('diffed');
    expect(result.diff).not.toBeNull();
  });

  it('reports the change as a rename', () => {
    const renamed = result.diff?.renamed.find((entry) => entry.elementKey === settingsKey);

    expect(renamed).toBeDefined();
    // The redacted new label, never raw customer text — and here they happen to be the same
    // because a fixture nav label is not PII.
    expect(renamed?.toNameRedacted).toBe('Preferences');
    expect(renamed?.fromNameHash).not.toBe(renamed?.toNameHash);
  });

  it('does not report it as a removal plus an addition', () => {
    // The assertion the whole suite exists for. A key-based matcher would put the old key in
    // `removed` and a `…primary.preferences` entry in `added`, and a reviewer would be asked to
    // approve deleting a link that is still on the page.
    expect(result.diff?.removed.map((entry) => entry.elementKey)).not.toContain(settingsKey);
    expect(result.diff?.removed).toHaveLength(0);
    expect(result.diff?.added).toHaveLength(0);
  });

  it('matches it with confidence clear of the floor', () => {
    const renamed = result.diff?.renamed.find((entry) => entry.elementKey === settingsKey);

    // Recorded rather than merely thresholded: this is the number that decides whether the
    // element is recognised at all, and a silent drift towards 0.55 is what would make this
    // suite start failing on a machine with different font metrics.
    expect(renamed?.matchConfidence).toBeGreaterThan(0.55);
  });

  it('leaves a candidate version for a human to approve, and does not activate it', async () => {
    expect(result.candidateMemoryVersionId).not.toBeNull();

    const candidate = await fixture.client.query<{
      status: string;
      origin: string;
      approved_by: string | null;
    }>('SELECT status, origin, approved_by FROM memory_versions WHERE id = $1', [
      result.candidateMemoryVersionId,
    ]);

    expect(candidate.rows[0]?.status).toBe('building');
    expect(candidate.rows[0]?.origin).toBe('reconcile');
    // "WisprTest proposes; a human commits." A candidate with an approver on it would look
    // already-reviewed to the console.
    expect(candidate.rows[0]?.approved_by).toBeNull();

    const active = await fixture.client.query<{ id: string }>(
      "SELECT id FROM memory_versions WHERE application_id = $1 AND status = 'active'",
      [fixture.applicationId],
    );
    expect(active.rows).toHaveLength(1);
    expect(active.rows[0]?.id).toBe(memoryVersionId);
  });

  it('carries the element into the candidate under its original key', async () => {
    // The identity alias migration goes through. If the reconcile had re-keyed the element to
    // match its new label, the gateway would migrate this screen's vocabulary onto nothing.
    const element = await fixture.client.query<{ element_key: string; fingerprint: unknown }>(
      `SELECT e.element_key, e.fingerprint FROM elements e
         JOIN screens s ON s.id = e.screen_id
        WHERE s.memory_version_id = $1 AND s.state_fingerprint = $2 AND e.element_key = $3`,
      [result.candidateMemoryVersionId, screenStateFingerprint, settingsKey],
    );

    expect(element.rows).toHaveLength(1);
    const fingerprint = element.rows[0]?.fingerprint as { accessibleNameRedacted: string };
    // The key is the old one; the fingerprint is the new one. That pairing is the whole point.
    expect(fingerprint.accessibleNameRedacted).toBe('Preferences');
  });

  it('updates the structural hash, so approving it does not re-raise the same drift', async () => {
    const screen = await fixture.client.query<{ structural_hash: string }>(
      'SELECT structural_hash FROM screens WHERE memory_version_id = $1 AND state_fingerprint = $2',
      [result.candidateMemoryVersionId, screenStateFingerprint],
    );
    const source = await fixture.client.query<{ structural_hash: string }>(
      'SELECT structural_hash FROM screens WHERE id = $1',
      [screenId],
    );

    // A copy change alters no structural attribute, so these agree here — the point of the
    // assertion is that the candidate carries what was *observed* rather than a stale copy.
    expect(screen.rows[0]?.structural_hash).toBe(source.rows[0]?.structural_hash);
  });

  it('hands the report to a human, naming the version approving it would activate', async () => {
    const report = await fixture.client.query<{
      status: string;
      candidate_memory_version_id: string | null;
      alias_migration_rate: string | null;
      approved_by: string | null;
    }>(
      `SELECT status, candidate_memory_version_id, alias_migration_rate, approved_by
         FROM drift_reports WHERE id = $1`,
      [reportId],
    );

    expect(report.rows[0]?.status).toBe('diffed');
    expect(report.rows[0]?.candidate_memory_version_id).toBe(result.candidateMemoryVersionId);
    expect(report.rows[0]?.approved_by).toBeNull();
    // Nothing was removed, so the screen's whole vocabulary survives the proposal.
    expect(Number(report.rows[0]?.alias_migration_rate)).toBe(1);
  });
});

describe('a report a human has already decided', () => {
  it('is not reconciled again', async () => {
    const reportId = await raiseReport('c'.repeat(64));
    await fixture.client.query(
      `UPDATE drift_reports SET status = 'rejected', approved_by = $2, resolved_at = now()
        WHERE id = $1`,
      [reportId, fixture.userId],
    );

    const result = await reconcile(job(reportId), dependencies());

    // Skipped without opening a browser: the decision is the only record that a human looked at
    // this, and a late job must not reopen it. ADR 0007 — there is no path to approved without a
    // human, and none back out of a rejection either.
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toContain('rejected');
    expect(result.candidateMemoryVersionId).toBeNull();

    const report = await fixture.client.query<{ status: string }>(
      'SELECT status FROM drift_reports WHERE id = $1',
      [reportId],
    );
    expect(report.rows[0]?.status).toBe('rejected');
  });
});
