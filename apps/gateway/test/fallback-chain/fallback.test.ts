import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { SeedExecuteResponse, SeedPlanResponse, SeedRevertResponse, Session } from 'protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createFakeComposer,
  planFixture,
  plannedResponse,
  type FakeComposer,
} from '../support/fake-composer.js';
import {
  createdResult,
  failedResult,
  revertedResult,
  startFakeSeedWorker,
  type FakeSeedWorker,
} from '../support/fake-seed-worker.js';
import { SEED, startHarness, type Harness } from '../support/harness.js';

/**
 * The fallback chain: fixture → api → ui → surface the failure with a concrete reason.
 *
 * docs/BUILD-PLAN.md Phase 16's chaos test, and the properties around it. One sentence in
 * docs/TEST-DATA-ENGINE.md § 4 is what all of this is defending:
 *
 * > Never silently degrade without telling the tester which adapter ran — it changes what the test
 * > actually covered. If the API adapter created the record, client-side validation was never
 * > exercised, and the tester needs to know that.
 *
 * So the assertions are not only "a record exists". They are that the failed rung is in the
 * ledger's attempt log, that the adapter which actually ran is recorded on the entry, that the
 * materializer which failed stopped being trusted, and that the preview said which adapter would
 * run *before* any of it happened.
 *
 * The worker is scripted, because what is under test is the gateway's response to a failure and a
 * real browser makes that slower to arrange, not more true. The adapters' own requests are tested
 * against a real application in `apps/indexer/test/e2e/seed.test.ts`.
 */

let harness: Harness;
let composer: FakeComposer;
let worker: FakeSeedWorker;
let client: Client;

const RUN = randomUUID().slice(0, 8);
let entitySchemaId: string;
let apiMaterializerId: string;
let detailScreenId: string;

/**
 * The plan every test in this file approves: one Order, created.
 *
 * Its fields are exactly the two the API materializer's observed payload has slots for, so
 * `canHandle` accepts and the adapter genuinely runs. A third field would be refused before the
 * chain ever dispatched — correctly, but it would test the refusal rather than the fallback.
 */
function orderPlan(sessionId: string) {
  return plannedResponse(
    planFixture({
      tenantId: SEED.tenantId,
      sessionId,
      memoryVersionId: SEED.memoryVersionId,
      entitySchemaId,
      nodes: [
        {
          nodeId: 'order-1',
          entity: `Order ${RUN}`,
          entitySchemaId,
          mode: 'create',
          existingExternalRef: null,
          fields: { customer: 'Composed Holdings', status: 'pending' },
          provenance: [
            {
              field: 'status',
              value: 'pending',
              source: 'requested',
              explanation: 'matched the enum value spoken as "pending"',
              confidence: 0.96,
            },
          ],
        },
      ],
    }),
  );
}

beforeAll(async () => {
  composer = createFakeComposer();
  harness = await startHarness({
    composer,
    config: { SEED_MATERIALIZE_TIMEOUT_MS: 1_000 },
  });
  worker = startFakeSeedWorker({
    redisUrl: harness.config.REDIS_URL,
    stream: harness.config.SEED_JOB_STREAM,
  });

  client = new Client({ connectionString: harness.config.DATABASE_URL });
  await client.connect();

  // An Order with BOTH an API and a UI materializer — the situation the chain exists for, and the
  // one the Phase 15 fixtures could not express because only one adapter existed.
  const schema = await client.query<{ id: string }>(
    `INSERT INTO entity_schemas
       (tenant_id, memory_version_id, entity_name, observed_count, confidence, delete_flow_element_key)
     VALUES ($1, $2, $3, 50, 0.92, 'orders.form.order-delete')
     RETURNING id`,
    [SEED.tenantId, SEED.memoryVersionId, `Order ${RUN}`],
  );
  entitySchemaId = schema.rows[0]?.id ?? '';

  await client.query(
    `INSERT INTO field_specs
       (tenant_id, entity_schema_id, name, type, required, control_element_key, value_constraints,
        enum_values)
     VALUES
       ($1, $2, 'customer', 'string', true, 'orders-new.create-order.customer', $3, NULL),
       ($1, $2, 'status', 'enum', true, 'orders-new.create-order.status', $3, $4)`,
    [
      SEED.tenantId,
      entitySchemaId,
      JSON.stringify({ min: null, max: null, minLength: null, maxLength: 80, pattern: null }),
      JSON.stringify(['pending', 'approved', 'shipped', 'cancelled']),
    ],
  );

  // Verified an hour ago, so it is *not* stale and genuinely sorts ahead of the UI adapter. A
  // never-verified one would be demoted before it ever ran, and the fallback under test would be
  // the ordering rule rather than the failure.
  const api = await client.query<{ id: string }>(
    `INSERT INTO materializers (tenant_id, entity_schema_id, kind, spec, priority, verified_at)
     VALUES ($1, $2, 'api', $3, 1, now() - interval '1 hour')
     RETURNING id`,
    [
      SEED.tenantId,
      entitySchemaId,
      JSON.stringify({
        kind: 'api',
        method: 'POST',
        path: '/api/v2/orders',
        payloadTemplate: { customer: '{{customer}}', status: '{{status}}' },
        auth: 'session',
        readBackPath: '/api/v2/orders/:id',
      }),
    ],
  );
  apiMaterializerId = api.rows[0]?.id ?? '';

  await client.query(
    `INSERT INTO materializers (tenant_id, entity_schema_id, kind, spec, priority)
     VALUES ($1, $2, 'ui', $3, 2)`,
    [
      SEED.tenantId,
      entitySchemaId,
      JSON.stringify({ kind: 'ui', form: 'orders-new.create-order', route: '/orders/new' }),
    ],
  );

  // The delete control on the record's OWN page. That is what makes an API-created record
  // revertible at all: the gateway reconstructs `/orders/<id>` from this route, because a replay
  // never landed anywhere to observe it. On a list route there would be nothing to substitute and
  // the preview would have to say the record cannot be removed.
  const screen = await client.query<{ id: string }>(
    `INSERT INTO screens
       (tenant_id, memory_version_id, route_pattern, state_fingerprint, label, structural_hash)
     VALUES ($1, $2, '/orders/:id', $3, 'Order detail', $4)
     RETURNING id`,
    [SEED.tenantId, SEED.memoryVersionId, 'e'.repeat(64), 'f'.repeat(64)],
  );
  detailScreenId = screen.rows[0]?.id ?? '';

  await client.query(
    `INSERT INTO elements
       (tenant_id, screen_id, element_key, role, accessible_name_hash, fingerprint, confidence,
        stability)
     VALUES ($1, $2, 'orders.form.order-delete', 'button', $3, $4, 0.95, 0.9)`,
    [
      SEED.tenantId,
      detailScreenId,
      'c'.repeat(64),
      JSON.stringify({
        role: 'button',
        tagName: 'button',
        accessibleNameHash: 'c'.repeat(64),
        accessibleNameRedacted: 'Delete',
        landmarkPath: ['main'],
        stableAttributes: { 'data-testid': 'order-delete' },
        ordinal: 0,
        textShingleHash: 'd'.repeat(64),
        bbox: { x: 0.1, y: 0.8, width: 0.1, height: 0.04 },
      }),
    ],
  );
}, 60_000);

afterAll(async () => {
  await client.query('DELETE FROM entity_schemas WHERE id = $1', [entitySchemaId]);
  await client.query('DELETE FROM screens WHERE id = $1', [detailScreenId]);
  await client.end();
  await worker.stop();
  await harness.close();
});

beforeEach(async () => {
  worker.jobs.length = 0;
  // Back to verified before each test, so a test that demotes the materializer cannot change what
  // the next one is testing.
  await client.query(
    `UPDATE materializers SET verified_at = now() - interval '1 hour' WHERE id = $1`,
    [apiMaterializerId],
  );
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

const RUNTIME_STATE = {
  route: '/orders',
  routePattern: '/orders',
  modalStack: [],
  focusedLandmark: 'region:orders',
  visibleElementKeys: ['orders.orders.view'],
  structuralHash: 'a'.repeat(64),
  stateFingerprint: '0f'.repeat(32),
  capturedAt: new Date().toISOString(),
};

/** Plan, and return the preview plus the id approval will name. */
async function plan(sessionId: string) {
  composer.reply(orderPlan(sessionId));

  const response = await harness.app.inject({
    method: 'POST',
    url: '/v1/seed/plan',
    headers: await authed(SEED.testerEmail),
    payload: JSON.stringify({
      sessionId,
      applicationId: SEED.applicationId,
      utterance: 'I need a pending order',
      runtimeState: RUNTIME_STATE,
      existingRecords: [],
      seed: 1841,
    }),
  });

  expect(response.statusCode).toBe(200);
  return SeedPlanResponse.parse(response.json());
}

async function execute(sessionId: string, planId: string) {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/v1/seed/execute',
    headers: await authed(SEED.leadEmail),
    payload: JSON.stringify({ sessionId, planId, approvedAt: new Date().toISOString() }),
  });
  return { status: response.statusCode, body: SeedExecuteResponse.parse(response.json()) };
}

async function verifiedAt(): Promise<Date | null> {
  const row = await client.query<{ verified_at: Date | null }>(
    'SELECT verified_at FROM materializers WHERE id = $1',
    [apiMaterializerId],
  );
  return row.rows[0]?.verified_at ?? null;
}

describe('the API adapter failing', () => {
  it('falls through to UI, creates the record, and records both rungs', async () => {
    const sessionId = await openSession();

    // The preview, before anything is written: the API adapter is what will run.
    const previewed = await plan(sessionId);
    expect(previewed.preview[0]?.adapter).toBe('api');
    expect(previewed.preview[0]?.revert.revertible).toBe(true);

    // Chaos: the API replay answers 500, the UI form works.
    worker.respondWith((job) =>
      job.operation === 'api_create'
        ? failedResult(job, 'POST /api/v2/orders answered 500')
        : createdResult(job, '4903'),
    );

    const { status, body } = await execute(sessionId, previewed.planId ?? '');

    expect(status).toBe(201);
    expect(body.result.outcome).toBe('created');
    // The record exists, and it was the UI adapter that made it.
    expect(body.result.adapterUsed).toBe('ui');
    expect(body.ledger).toHaveLength(1);
    expect(body.ledger[0]?.adapterUsed).toBe('ui');
    expect(body.ledger[0]?.externalRef).toBe('4903');

    // Both rungs, with the concrete reason for the one that failed. This is the assertion § 4 is
    // actually about: a tester reading this knows client-side validation *was* exercised, because
    // the fast path did not work.
    expect(body.result.attempts.map((attempt) => [attempt.adapter, attempt.outcome])).toEqual([
      ['api', 'failed'],
      ['ui', 'succeeded'],
    ]);
    expect(body.result.attempts[0]?.reason).toBe('POST /api/v2/orders answered 500');

    // Both adapters were actually asked, in that order, over the real stream.
    expect(worker.jobs.map((job) => job.operation)).toEqual(['api_create', 'ui_create']);
  });

  it('stops trusting the materializer that failed', async () => {
    const sessionId = await openSession();
    const previewed = await plan(sessionId);

    worker.respondWith((job) =>
      job.operation === 'api_create'
        ? failedResult(job, 'POST /api/v2/orders answered 500')
        : createdResult(job, '4904'),
    );
    await execute(sessionId, previewed.planId ?? '');

    // The demotion § 4 requires, and the half that was missing until now: something has to change
    // the column the ordering rule reads, or a broken endpoint is retried first forever.
    expect(await verifiedAt()).toBeNull();

    // And it is audited, so an operator can see why the fast path stopped being used.
    const audit = await client.query<{ action: string; metadata: { reason: string } }>(
      `SELECT action, metadata FROM audit_log
        WHERE tenant_id = $1 AND action = 'materializer-unverified' AND target = $2
        ORDER BY created_at DESC LIMIT 1`,
      [SEED.tenantId, apiMaterializerId],
    );
    expect(audit.rows[0]?.metadata.reason).toBe('POST /api/v2/orders answered 500');
  });

  it('demotes it below UI on the very next plan, and says so in the preview', async () => {
    const sessionId = await openSession();

    const first = await plan(sessionId);
    expect(first.preview[0]?.adapter).toBe('api');

    worker.respondWith((job) =>
      job.operation === 'api_create'
        ? failedResult(job, 'POST /api/v2/orders answered 500')
        : createdResult(job, '4905'),
    );
    await execute(sessionId, first.planId ?? '');

    // The loop closing. The tester is not told "api" and then given "ui" a second time — the
    // preview now promises what the chain will actually do.
    const second = await plan(sessionId);
    expect(second.preview[0]?.adapter).toBe('ui');
    expect(second.preview[0]?.adapterReason).toContain('has never been verified');
    expect(second.preview[0]?.adapterReason).toContain('the ui materializer will run instead');

    worker.jobs.length = 0;
    worker.respondWith((job) => createdResult(job, '4906'));
    const { body } = await execute(sessionId, second.planId ?? '');

    expect(body.result.adapterUsed).toBe('ui');
    // Only the UI adapter was dispatched. The API one is still in the chain — demotion, not
    // exclusion — but it now sorts behind an adapter that works, and the chain stops at the first
    // success, so it is never reached.
    expect(worker.jobs.map((job) => job.operation)).toEqual(['ui_create']);
  });
});

describe('the API adapter succeeding', () => {
  it('keeps the fast path and marks the materializer verified', async () => {
    const sessionId = await openSession();
    const previewed = await plan(sessionId);

    worker.respondWith((job) => createdResult(job, '5001'));
    const { body } = await execute(sessionId, previewed.planId ?? '');

    expect(body.result.adapterUsed).toBe('api');
    expect(body.ledger[0]?.adapterUsed).toBe('api');
    // Only one rung: the chain stops at the first adapter that works.
    expect(body.result.attempts.map((attempt) => attempt.adapter)).toEqual(['api']);
    expect(worker.jobs.map((job) => job.operation)).toEqual(['api_create']);

    const stamped = await verifiedAt();
    expect(stamped).not.toBeNull();
    expect(stamped?.getTime() ?? 0).toBeGreaterThan(Date.now() - 60_000);
  });

  it('reverts an API-created record through the reconstructed page', async () => {
    const sessionId = await openSession();
    const previewed = await plan(sessionId);

    worker.respondWith((job) => createdResult(job, '5002'));
    const { body } = await execute(sessionId, previewed.planId ?? '');
    const entry = body.ledger[0];
    expect(entry?.adapterUsed).toBe('api');
    // A replay never landed anywhere, so the path was rebuilt from the route the delete control
    // was indexed on. Without it, a list of identical delete buttons cannot be aimed.
    expect(entry?.inverseOp).toEqual({ kind: 'ui', flow: 'orders.form.order-delete' });

    worker.jobs.length = 0;
    worker.respondWith((job) => revertedResult(job));

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/seed/revert',
      headers: await authed(SEED.leadEmail),
      payload: JSON.stringify({ scope: 'entry', ledgerEntryId: entry?.id }),
    });

    expect(response.statusCode).toBe(200);
    const reverted = SeedRevertResponse.parse(response.json());
    expect(reverted.outcomes[0]?.outcome).toBe('reverted');

    // The record was created by one adapter and undone by another, because the inverse operation
    // names what the application actually offers rather than what happened to create it.
    const [job] = worker.jobs;
    expect(job?.operation).toBe('ui_revert');
    if (job?.operation !== 'ui_revert') return;
    expect(job.detailPath).toBe('/orders/5002');
  });
});

describe('nothing being able to create the record', () => {
  it('surfaces every rung with its own concrete reason', async () => {
    const sessionId = await openSession();
    const previewed = await plan(sessionId);

    worker.respondWith((job) =>
      failedResult(
        job,
        job.operation === 'api_create'
          ? 'POST /api/v2/orders answered 500'
          : 'the create form no longer holds status',
      ),
    );

    const { status, body } = await execute(sessionId, previewed.planId ?? '');

    // Not an HTTP error: the attempts *are* the answer, and the extension renders them.
    expect(status).toBe(200);
    expect(body.result.outcome).toBe('failed');
    expect(body.ledger).toEqual([]);
    expect(body.result.failureReason).toBe('the create form no longer holds status');
    expect(body.result.attempts.map((attempt) => attempt.reason)).toEqual([
      'POST /api/v2/orders answered 500',
      'the create form no longer holds status',
    ]);
    expect(await verifiedAt()).toBeNull();
  });
});
