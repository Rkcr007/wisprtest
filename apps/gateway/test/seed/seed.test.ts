import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import {
  SeedExecuteResponse,
  SeedPlanResponse,
  SeedRevertResponse,
  Session,
  type CompositionPlan,
} from 'protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createFakeComposer,
  planFixture,
  plannedResponse,
  CONSTRAINT_SET,
  type FakeComposer,
} from '../support/fake-composer.js';
import {
  createdResult,
  failedResult,
  revertedResult,
  startFakeSeedWorker,
  type FakeSeedWorker,
} from '../support/fake-seed-worker.js';
import { NEIGHBOUR, SEED, startHarness, type Harness } from '../support/harness.js';

/**
 * The seed routes, against the real stack.
 *
 * docs/BUILD-PLAN.md Phase 15's gateway half. Postgres and Redis are the Compose ones; the
 * composer and the browser are scripted, each for a stated reason (see the two support modules).
 * Everything between them is the real thing: the policy check the database computes, the plan
 * held in Redis, the job encoded onto the stream the indexer reads, the ledger row, the audit
 * entry, and the revert that has to find the record's own path to aim at.
 *
 * The properties this suite exists to hold:
 *
 * - **Nothing is written without an approved preview.** Class S, per the reversibility taxonomy.
 *   `plan` writes nothing; `execute` runs only a plan the gateway itself composed and is holding.
 * - **The previewed bytes are the written bytes.** Approval names a plan id, so an edited plan is
 *   not expressible. Proven by trying.
 * - **Production is blocked, and the attempt is audited.** Including the refusal.
 * - **The preview tells the truth about what will happen** — which adapter, and whether the
 *   record can be removed — before anything exists.
 * - **A revert that did not remove the record does not say it did.**
 */

let harness: Harness;
let composer: FakeComposer;
let worker: FakeSeedWorker;
let client: Client;

/** Ids for rows this suite creates. Fixed per run so a failure names a row you can look at. */
const RUN = randomUUID().slice(0, 8);
let entitySchemaId: string;
let productionApplicationId: string;

beforeAll(async () => {
  composer = createFakeComposer();
  harness = await startHarness({
    composer,
    // Short, so a job nobody answers fails in a second rather than holding the suite for a
    // minute. The production value is sized for a real form fill; what is under test here is the
    // round trip, not how long a browser takes.
    config: { SEED_MATERIALIZE_TIMEOUT_MS: 1_000 },
  });
  worker = startFakeSeedWorker({
    redisUrl: harness.config.REDIS_URL,
    stream: harness.config.SEED_JOB_STREAM,
  });

  client = new Client({ connectionString: harness.config.DATABASE_URL });
  await client.connect();

  // A learned Order schema on the seeded memory version, with a UI materializer and an indexed
  // delete flow — what the indexer would have written after crawling this application.
  const schema = await client.query<{ id: string }>(
    `INSERT INTO entity_schemas
       (tenant_id, memory_version_id, entity_name, observed_count, confidence, delete_flow_element_key)
     VALUES ($1, $2, $3, 50, 0.92, 'orders.form.order-delete')
     RETURNING id`,
    [SEED.tenantId, SEED.memoryVersionId, `Order`],
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
      // The full shape the observers write. The column defaults to `{}`, which the contract
      // rejects — a fixture that leaned on the default would be testing a row the indexer never
      // produces.
      JSON.stringify({ min: null, max: null, minLength: null, maxLength: 80, pattern: null }),
      JSON.stringify(['pending', 'approved', 'shipped', 'cancelled']),
    ],
  );

  await client.query(
    `INSERT INTO materializers (tenant_id, entity_schema_id, kind, spec, priority)
     VALUES ($1, $2, 'ui', $3, 2)`,
    [
      SEED.tenantId,
      entitySchemaId,
      JSON.stringify({ kind: 'ui', form: 'orders-new.create-order', route: '/orders/new' }),
    ],
  );

  // A second application, in production and not opted in. The policy path needs one.
  const production = await client.query<{ id: string }>(
    `INSERT INTO applications (tenant_id, name, base_url, env)
     VALUES ($1, $2, 'https://prod.northwind.example', 'production') RETURNING id`,
    [SEED.tenantId, `Northwind Production ${RUN}`],
  );
  productionApplicationId = production.rows[0]?.id ?? '';

  await client.query(
    `INSERT INTO memory_versions (id, tenant_id, application_id, version, status)
     VALUES ($1, $2, $3, 1, 'active')`,
    [productionMemoryVersionId, SEED.tenantId, productionApplicationId],
  );
}, 60_000);

const productionMemoryVersionId = randomUUID();

afterAll(async () => {
  await client.query('DELETE FROM applications WHERE id = $1', [productionApplicationId]);
  await client.query('DELETE FROM entity_schemas WHERE id = $1', [entitySchemaId]);
  await client.end();
  await worker.stop();
  await harness.close();
});

beforeEach(() => {
  worker.jobs.length = 0;
  worker.respondWith((job) => createdResult(job, `4903-${randomUUID().slice(0, 4)}`));
});

async function authed(email: string) {
  const token = await harness.issuer.sign({ email });
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function openSession(
  applicationId: string = SEED.applicationId,
  memoryVersionId: string = SEED.memoryVersionId,
) {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: await authed(SEED.testerEmail),
    payload: JSON.stringify({ applicationId, memoryVersionId }),
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

async function postPlan(
  sessionId: string,
  applicationId: string = SEED.applicationId,
  email: string = SEED.testerEmail,
) {
  return harness.app.inject({
    method: 'POST',
    url: '/v1/seed/plan',
    headers: await authed(email),
    payload: JSON.stringify({
      sessionId,
      applicationId,
      utterance: 'I need a pending order',
      runtimeState: RUNTIME_STATE,
      existingRecords: [],
      seed: 1841,
    }),
  });
}

async function postExecute(sessionId: string, planId: string, email: string = SEED.leadEmail) {
  return harness.app.inject({
    method: 'POST',
    url: '/v1/seed/execute',
    headers: await authed(email),
    payload: JSON.stringify({ sessionId, planId, approvedAt: new Date().toISOString() }),
  });
}

async function postRevert(body: unknown, email: string = SEED.leadEmail) {
  return harness.app.inject({
    method: 'POST',
    url: '/v1/seed/revert',
    headers: await authed(email),
    payload: JSON.stringify(body),
  });
}

/** Compose a plan and return it with the id the gateway is holding it under. */
async function heldPlan(sessionId: string): Promise<{ planId: string; plan: CompositionPlan }> {
  const plan = planFixture({
    tenantId: SEED.tenantId,
    sessionId,
    memoryVersionId: SEED.memoryVersionId,
    entitySchemaId,
  });
  composer.reply(plannedResponse(plan));

  const response = await postPlan(sessionId);
  expect(response.statusCode).toBe(200);
  const body = SeedPlanResponse.parse(response.json());
  expect(body.planId).toBe(plan.id);
  return { planId: plan.id, plan };
}

describe('composing a plan', () => {
  it('writes nothing, and previews the adapter and the revert', async () => {
    const sessionId = await openSession();
    const plan = planFixture({
      tenantId: SEED.tenantId,
      sessionId,
      memoryVersionId: SEED.memoryVersionId,
      entitySchemaId,
    });
    composer.reply(plannedResponse(plan));

    const response = await postPlan(sessionId);
    expect(response.statusCode).toBe(200);

    const body = SeedPlanResponse.parse(response.json());
    expect(body.planId).toBe(plan.id);
    expect(body.expiresAt).not.toBeNull();
    expect(body.preview).toHaveLength(1);

    const [preview] = body.preview;
    expect(preview?.entity).toBe('Order');
    expect(preview?.mode).toBe('create');
    // Which adapter will run, before anything runs. § 4 forbids finding this out afterwards.
    expect(preview?.adapter).toBe('ui');
    expect(preview?.revert.revertible).toBe(true);
    expect(preview?.revert.detail).toContain('orders.form.order-delete');

    // Nothing was created and nothing was queued.
    expect(worker.jobs).toHaveLength(0);
    const ledger = await client.query('SELECT 1 FROM seed_ledger WHERE plan_id = $1', [plan.id]);
    expect(ledger.rowCount).toBe(0);
  });

  it('takes the memory version from the session, not from the caller', async () => {
    const sessionId = await openSession();
    await heldPlan(sessionId);

    const request = composer.requests.at(-1);
    expect(request?.memoryVersionId).toBe(SEED.memoryVersionId);
    expect(request?.sessionId).toBe(sessionId);
    // Every schema of the version, not a guess at which one the utterance means.
    expect(request?.schemas.map((schema) => schema.entityName)).toContain('Order');
  });

  it('passes a conflict back as an answer rather than an error', async () => {
    const sessionId = await openSession();
    composer.reply({
      constraintSet: CONSTRAINT_SET,
      outcome: {
        kind: 'conflict',
        constraintSet: CONSTRAINT_SET,
        conflict: {
          left: {
            kind: 'constraint',
            constraint: { kind: 'comparison', field: 'amount', op: 'gt', value: 50000 },
          },
          right: {
            kind: 'constraint',
            constraint: { kind: 'comparison', field: 'amount', op: 'lt', value: 1000 },
          },
          field: 'amount',
          explanation: 'amount cannot be both over 50,000 and under 1,000',
        },
      },
      parseTier: 'T2',
      durationMs: 812,
    });

    const response = await postPlan(sessionId);
    // 200: the request was understood. It is the utterance that cannot be satisfied, and a 4xx
    // would tell the extension to retry something that will never work.
    expect(response.statusCode).toBe(200);

    const body = SeedPlanResponse.parse(response.json());
    expect(body.composition.outcome.kind).toBe('conflict');
    expect(body.planId).toBeNull();
    expect(body.preview).toHaveLength(0);
    expect(body.expiresAt).toBeNull();
  });
});

describe('environment policy', () => {
  it('refuses a production application nobody opted in, and audits the attempt', async () => {
    const sessionId = await openSession(productionApplicationId, productionMemoryVersionId);

    const response = await postPlan(sessionId, productionApplicationId);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'seeding_forbidden', environment: 'production' });

    const audit = await client.query<{ action: string; metadata: { reason: string } }>(
      `SELECT action, metadata FROM audit_log
        WHERE tenant_id = $1 AND target = $2 ORDER BY created_at DESC LIMIT 1`,
      [SEED.tenantId, productionApplicationId],
    );
    expect(audit.rows[0]?.action).toBe('seed-plan.refused');
    expect(audit.rows[0]?.metadata.reason).toBe('seeding_forbidden');

    // The composer was never asked. A refusal that still spent a model call would be a refusal
    // that costs money to be told no.
    expect(composer.requests.every((request) => request.sessionId !== sessionId)).toBe(true);
  });

  it('allows the same application once it is auditably enabled', async () => {
    await client.query(
      `UPDATE applications
          SET seeding_enabled_at = now(), seeding_enabled_by = $2,
              seeding_enabled_reason = 'isolated sandbox tenant, approved by platform'
        WHERE id = $1`,
      [productionApplicationId, '22222222-2222-4222-8222-222222222221'],
    );

    try {
      const sessionId = await openSession(productionApplicationId, productionMemoryVersionId);
      composer.reply(
        plannedResponse(
          planFixture({
            tenantId: SEED.tenantId,
            sessionId,
            memoryVersionId: productionMemoryVersionId,
            entitySchemaId,
          }),
        ),
      );

      const response = await postPlan(sessionId, productionApplicationId);
      // The application has no learned schemas of its own, so this refuses on schema confidence —
      // which is the *next* gate. What matters is that it is no longer refused on policy.
      expect(response.statusCode).not.toBe(403);
    } finally {
      await client.query(
        `UPDATE applications
            SET seeding_enabled_at = NULL, seeding_enabled_by = NULL, seeding_enabled_reason = NULL
          WHERE id = $1`,
        [productionApplicationId],
      );
    }
  });
});

describe('approving a plan', () => {
  it('materializes it, writes the ledger, and audits the write', async () => {
    const sessionId = await openSession();
    const { planId, plan } = await heldPlan(sessionId);

    const response = await postExecute(sessionId, planId);
    expect(response.statusCode).toBe(201);

    const body = SeedExecuteResponse.parse(response.json());
    expect(body.result.outcome).toBe('created');
    expect(body.result.adapterUsed).toBe('ui');
    expect(body.result.verifiedAt).not.toBeNull();
    expect(body.ledger).toHaveLength(1);

    const [entry] = body.ledger;
    expect(entry?.entity).toBe('Order');
    expect(entry?.adapterUsed).toBe('ui');
    expect(entry?.inverseOp).toEqual({ kind: 'ui', flow: 'orders.form.order-delete' });
    // The provenance the preview rendered is the provenance the ledger keeps. It is what makes a
    // seeded record auditable after the fact (§ 7's last row).
    expect(entry?.provenance.map((item) => item.field)).toEqual(['status', 'customer']);

    // The job that actually went to the worker, off the real stream.
    expect(worker.jobs).toHaveLength(1);
    const [job] = worker.jobs;
    expect(job?.operation).toBe('create');
    if (job?.operation === 'create') {
      expect(job.form).toBe('orders-new.create-order');
      // Fields resolved to the controls the form observer indexed, not to selectors.
      expect(job.values.map((value) => value.controlElementKey).sort()).toEqual([
        'orders-new.create-order.customer',
        'orders-new.create-order.status',
      ]);
    }

    const audit = await client.query<{ action: string; metadata: { planId: string } }>(
      `SELECT action, metadata FROM audit_log
        WHERE tenant_id = $1 AND action = 'seed-execute' ORDER BY created_at DESC LIMIT 1`,
      [SEED.tenantId],
    );
    expect(audit.rows[0]?.metadata.planId).toBe(plan.id);
  });

  it('refuses a plan id the gateway is not holding', async () => {
    const sessionId = await openSession();
    const response = await postExecute(sessionId, randomUUID());

    expect(response.statusCode).toBe(400);
    expect(worker.jobs).toHaveLength(0);
  });

  it('refuses to run the same plan twice', async () => {
    const sessionId = await openSession();
    const { planId } = await heldPlan(sessionId);

    expect((await postExecute(sessionId, planId)).statusCode).toBe(201);
    // The plan is released once it has run. A second approval would otherwise create the record
    // again — one preview, two rows in the customer's application.
    expect((await postExecute(sessionId, planId)).statusCode).toBe(400);
    expect(worker.jobs).toHaveLength(1);
  });

  it('refuses a plan belonging to another session', async () => {
    const sessionId = await openSession();
    const { planId } = await heldPlan(sessionId);
    const otherSession = await openSession();

    const response = await postExecute(otherSession, planId);
    expect(response.statusCode).toBe(400);
    expect(worker.jobs).toHaveLength(0);
  });

  it('reports a failed materialization with the adapter and the reason, and writes no ledger row', async () => {
    const sessionId = await openSession();
    const { planId, plan } = await heldPlan(sessionId);
    worker.respondWith((job) => failedResult(job, 'the create form no longer holds po_number'));

    const response = await postExecute(sessionId, planId);
    expect(response.statusCode).toBe(200);

    const body = SeedExecuteResponse.parse(response.json());
    expect(body.result.outcome).toBe('failed');
    expect(body.result.failureReason).toContain('po_number');
    expect(body.ledger).toHaveLength(0);
    expect(body.result.attempts.map((attempt) => attempt.outcome)).toEqual(['failed']);

    const rows = await client.query('SELECT 1 FROM seed_ledger WHERE plan_id = $1', [plan.id]);
    expect(rows.rowCount).toBe(0);
  });

  it('does not resolve a plan id belonging to another tenant', async () => {
    const sessionId = await openSession();
    const { planId } = await heldPlan(sessionId);

    // The neighbour's own session, in the neighbour's own tenant, approving an id it should have
    // no way to know. Held plans are keyed by tenant, so the id resolves to a key this caller
    // cannot reach — the same shape as row-level security, applied to a cache.
    const neighbourSession = await harness.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: await authed(NEIGHBOUR.ownerEmail),
      payload: JSON.stringify({
        applicationId: NEIGHBOUR.applicationId,
        memoryVersionId: NEIGHBOUR.memoryVersionId,
      }),
    });
    expect(neighbourSession.statusCode).toBe(201);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/seed/execute',
      headers: await authed(NEIGHBOUR.ownerEmail),
      payload: JSON.stringify({
        sessionId: Session.parse(neighbourSession.json()).id,
        planId,
        approvedAt: new Date().toISOString(),
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(worker.jobs).toHaveLength(0);

    // And the plan is still there for its own tenant, unconsumed by the attempt.
    expect((await postExecute(sessionId, planId)).statusCode).toBe(201);
  });

  it('does not let a tester approve their own plan', async () => {
    const sessionId = await openSession();
    const { planId } = await heldPlan(sessionId);

    // `seed:execute` is lead and above: composing is a tester's job, writing to the customer's
    // application is signed off. Same shape as drift approval, and for the same reason.
    const response = await postExecute(sessionId, planId, SEED.testerEmail);
    expect(response.statusCode).toBe(403);
    expect(worker.jobs).toHaveLength(0);
  });
});

describe('reverting', () => {
  it('removes one record and stamps the ledger only after the adapter succeeded', async () => {
    const sessionId = await openSession();
    const { planId } = await heldPlan(sessionId);
    const executed = SeedExecuteResponse.parse((await postExecute(sessionId, planId)).json());
    const entry = executed.ledger[0];
    if (entry === undefined) throw new Error('nothing was created');

    worker.jobs.length = 0;
    worker.respondWith((job) => revertedResult(job));

    const response = await postRevert({ scope: 'entry', ledgerEntryId: entry.id });
    expect(response.statusCode).toBe(200);

    const body = SeedRevertResponse.parse(response.json());
    expect(body.outcomes).toEqual([
      {
        ledgerEntryId: entry.id,
        entity: 'Order',
        externalRef: entry.externalRef,
        outcome: 'reverted',
        reason: null,
      },
    ]);

    // The delete flow was aimed using the record's own path, read back when it was created.
    const [job] = worker.jobs;
    expect(job?.operation).toBe('revert');
    if (job?.operation === 'revert') {
      expect(job.flow).toBe('orders.form.order-delete');
      expect(job.detailPath).toBe(`/orders/${entry.externalRef}`);
    }

    const row = await client.query<{ reverted_at: Date | null }>(
      'SELECT reverted_at FROM seed_ledger WHERE id = $1',
      [entry.id],
    );
    expect(row.rows[0]?.reverted_at).not.toBeNull();
  });

  it('leaves the ledger unstamped when the delete flow did not remove the record', async () => {
    const sessionId = await openSession();
    const { planId } = await heldPlan(sessionId);
    const executed = SeedExecuteResponse.parse((await postExecute(sessionId, planId)).json());
    const entry = executed.ledger[0];
    if (entry === undefined) throw new Error('nothing was created');

    worker.respondWith((job) =>
      failedResult(job, 'the record is still reachable after the delete'),
    );

    const body = SeedRevertResponse.parse(
      (await postRevert({ scope: 'entry', ledgerEntryId: entry.id })).json(),
    );
    expect(body.outcomes[0]?.outcome).toBe('failed');
    expect(body.outcomes[0]?.reason).toContain('still reachable');

    // The claim that matters. An entry marked reverted whose record is still there tells the
    // tester their staging data is clean when it is not, and nothing will look at it again.
    const row = await client.query<{ reverted_at: Date | null }>(
      'SELECT reverted_at FROM seed_ledger WHERE id = $1',
      [entry.id],
    );
    expect(row.rows[0]?.reverted_at).toBeNull();
  });

  it('reverts a whole session in reverse creation order', async () => {
    const sessionId = await openSession();
    const refs: string[] = [];

    for (const marker of ['first', 'second', 'third']) {
      const { planId } = await heldPlan(sessionId);
      worker.respondWith((job) => createdResult(job, `${marker}-${RUN}`));
      const executed = SeedExecuteResponse.parse((await postExecute(sessionId, planId)).json());
      refs.push(executed.ledger[0]?.externalRef ?? '');
    }

    worker.respondWith((job) => revertedResult(job));
    const body = SeedRevertResponse.parse(
      (await postRevert({ scope: 'session', sessionId })).json(),
    );

    expect(body.outcomes.map((outcome) => outcome.outcome)).toEqual([
      'reverted',
      'reverted',
      'reverted',
    ]);
    // Newest first is reverse insertion order, which is reverse dependency order: a row that
    // points at another goes before the row it points at.
    expect(body.outcomes.map((outcome) => outcome.externalRef)).toEqual([...refs].reverse());
  });

  it('reports an entry that was already reverted rather than reverting it again', async () => {
    const sessionId = await openSession();
    const { planId } = await heldPlan(sessionId);
    const executed = SeedExecuteResponse.parse((await postExecute(sessionId, planId)).json());
    const entry = executed.ledger[0];
    if (entry === undefined) throw new Error('nothing was created');

    worker.respondWith((job) => revertedResult(job));
    await postRevert({ scope: 'entry', ledgerEntryId: entry.id });

    worker.jobs.length = 0;
    const body = SeedRevertResponse.parse(
      (await postRevert({ scope: 'entry', ledgerEntryId: entry.id })).json(),
    );

    expect(body.outcomes[0]?.outcome).toBe('already_reverted');
    // And no second delete was driven at a record that is already gone.
    expect(worker.jobs).toHaveLength(0);
  });
});
