import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { pino } from 'pino';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchBrowser } from '../../src/crawl/browser.js';
import { createSecretResolver } from '../../src/crawl/secrets.js';
import { createTenantDatabase, type TenantDatabase } from '../../src/db/pool.js';
import { runJob } from '../../src/job-runner.js';
import { createRedis } from '../../src/redis/client.js';
import { materializeOverHttp, type HttpJob } from '../../src/seed/http.js';
import type { MaterializerDependencies, UiJob } from '../../src/seed/materializer.js';
import { materialize } from '../../src/seed/materializer.js';
import { createMetrics } from '../../src/telemetry/metrics.js';
import { startFixtureApp, type FixtureApp } from '../fixture-app/server.js';
import {
  createFixture,
  fixtureBounds,
  fixtureJob,
  readMemory,
  readSchemas,
  testConfig,
  type Fixture,
  type LearnedEntity,
} from '../support/harness.js';

/**
 * All three materializers, against a real application.
 *
 * The half of docs/BUILD-PLAN.md Phases 15 and 16 that lives in this service. Nothing is mocked: a
 * real browser crawls a real Express application to build the memory, and then a second browser
 * session writes into that application — by driving its create form from the fingerprints the
 * crawl stored, by replaying the create request the crawl observed, or by posting to the seeding
 * endpoint a customer configured. Every record is asserted against the application's own API, not
 * against anything an adapter reported about itself.
 *
 * All three share one crawl, deliberately. They are three answers to the same question — how does
 * a record get into this application — and the memory they work from has to be the same memory, or
 * the suite stops being able to say the API materializer and the UI materializer describe the same
 * entity.
 *
 * ## What is actually being tested
 *
 * Not "the adapter ran". Three claims that the phase turns on:
 *
 * 1. **A form indexed once can be filled later from memory alone.** No selector, no field name,
 *    no label text crosses from the crawl to the fill — only element keys and the fingerprints
 *    behind them, resolved through `packages/fingerprint` (CLAUDE.md rule #4).
 * 2. **The record is identifiable afterwards.** The adapter reads the identifier back off the
 *    route the application landed on, which is what makes the ledger entry — and therefore the
 *    revert — possible at all.
 * 3. **Revert removes the right record.** The fixture's delete control is a list-row button,
 *    identical in every fingerprint signal to the delete button of every other order. Deleting
 *    the wrong one is the worst thing this code can do, so the suite creates two records and
 *    asserts the untouched one survives.
 * 4. **A replay that wrote nothing is caught.** The only create request a crawl can observe here
 *    is the form's dry run, which computes and returns without writing. The materializer inferred
 *    from it replays a request that, as observed, was a no-op — and reading the record back is the
 *    only thing that distinguishes the two outcomes.
 * 5. **Neither HTTP adapter can be pointed off the application.** Both take a path from data — an
 *    observed spec, or a customer-configured command — and a database column that could dial
 *    anywhere would be an SSRF reachable through configuration.
 */

const config = testConfig();

let browser: Browser;
let database: TenantDatabase;
let redis: Redis;
let app: FixtureApp;
let fixture: Fixture;
let memoryVersionId: string;
let order: LearnedEntity;
let deleteElementKey: string;
let accountId: string;

const logger = pino({ level: config.LOG_LEVEL });

function dependencies(): MaterializerDependencies {
  return { database, browser, secrets: createSecretResolver() };
}

/** The element key of the control that edits one learned field. */
function controlFor(field: string): string {
  const spec = order.fields.find((candidate) => candidate.name === field);
  if (spec?.controlElementKey == null) {
    throw new Error(
      `Order.${field} has no indexed control; fields with one: ${order.fields
        .filter((candidate) => candidate.controlElementKey !== null)
        .map((candidate) => candidate.name)
        .join(', ')}`,
    );
  }
  return spec.controlElementKey;
}

/**
 * A create job that fills every field the form marks required.
 *
 * All four of them, because the browser will not submit otherwise — which is the UI adapter
 * earning its place in the chain (docs/TEST-DATA-ENGINE.md § 4: it "exercises real validation").
 * A composed plan reaches the same place from the other direction: the solver fills
 * required-but-unspecified fields precisely so the application accepts the record.
 */
function createJob(overrides: Partial<UiJob<'ui_create'>> = {}): UiJob {
  return {
    operation: 'ui_create',
    jobId: randomUUID(),
    tenantId: fixture.tenantId,
    applicationId: fixture.applicationId,
    memoryVersionId,
    sessionId: randomUUID(),
    planId: randomUUID(),
    nodeId: 'order-1',
    entity: 'Order',
    form: 'orders-new.create-order',
    route: '/orders/new',
    values: requiredValues('Composed Holdings', 'PO-4903'),
    deadlineMs: 60_000,
    ...overrides,
  };
}

/** Values for every required control, with the account reference resolved to a real record. */
function requiredValues(customer: string, poNumber: string): UiJob<'ui_create'>['values'] {
  return [
    { field: 'customer', controlElementKey: controlFor('customer'), value: customer },
    { field: 'accountId', controlElementKey: controlFor('accountId'), value: accountId },
    { field: 'po_number', controlElementKey: controlFor('po_number'), value: poNumber },
    { field: 'amount', controlElementKey: controlFor('amount'), value: 1250.5 },
  ];
}

/** Orders as the application itself reports them. The adapter's claims are checked against these. */
async function ordersFromApi(): Promise<{ id: number; customer: string }[]> {
  const response = await fetch(`${app.url}/api/v2/orders`);
  const body = (await response.json()) as { data: { id: number; customer: string }[] };
  return body.data;
}

beforeAll(async () => {
  browser = await launchBrowser(true);
  database = createTenantDatabase(config);
  redis = createRedis(config);
  await redis.connect();

  app = await startFixtureApp();
  fixture = await createFixture(app.url);

  const job = fixtureJob(fixture, app.url, fixtureBounds(app.url));
  const outcome = await runJob(
    job,
    {
      database,
      redis,
      browser,
      secrets: createSecretResolver(),
      metrics: createMetrics(),
      logger,
      progressMaxLength: config.INDEXER_PROGRESS_MAXLEN,
    },
    new AbortController().signal,
  );
  expect(outcome.status).toBe('completed');

  const memory = await readMemory(fixture.client, fixture.applicationId);
  if (memory === null) throw new Error('the crawl wrote no memory version');
  memoryVersionId = memory.version.id;

  const entities = await readSchemas(fixture.client, memoryVersionId);
  const learned = entities.find((entity) => entity.entityName === 'Order');
  if (learned === undefined) {
    throw new Error(`no Order schema; learned: ${entities.map((e) => e.entityName).join(', ')}`);
  }
  order = learned;

  // The delete control the crawl indexed on the orders list, discovered rather than hardcoded —
  // the key is minted by the crawl, and this suite should notice if that minting changes rather
  // than being pinned to one spelling of it.
  //
  // Note what the crawl produced: `orders.form.order-delete`, `…-2`, `…-3`, one per row it saw.
  // The job below names exactly one of them, and the record it reverts will be in a *different*
  // row, created after the crawl. That is the case `locateRecordControl` exists for.
  const deletes = memory.elements.filter(
    (element) => element.elementKey.startsWith('orders.') && element.elementKey.includes('delete'),
  );
  const [first] = deletes;
  if (first === undefined) {
    throw new Error(
      `the crawl indexed no delete control; keys: ${memory.elements
        .map((element) => element.elementKey)
        .join(', ')}`,
    );
  }
  deleteElementKey = first.elementKey;

  // A real account to point the order's reference at. This is what the composer's reference
  // resolution supplies in production — § 3: "prefer an existing real record".
  const accounts = (await (await fetch(`${app.url}/api/v2/accounts`)).json()) as {
    data: { id: string }[];
  };
  const [account] = accounts.data;
  if (account === undefined) throw new Error('the fixture application has no accounts');
  accountId = account.id;
}, 240_000);

afterAll(async () => {
  await fixture.drop();
  await app.close();
  await browser.close();
  await database.close();
  await redis.quit();
});

describe('creating a record through the real form', () => {
  it('fills the indexed controls, submits, and reads the identifier back', async () => {
    const before = await ordersFromApi();

    const result = await materialize(createJob(), dependencies());

    expect(result.failureReason).toBeNull();
    expect(result.outcome).toBe('succeeded');
    expect(result.externalRef).not.toBeNull();
    expect(result.detailPath).toMatch(/^\/orders\/\d+$/);

    // The application's own account of what exists, not the adapter's.
    const after = await ordersFromApi();
    expect(after.length).toBe(before.length + 1);

    const created = after.find((row) => String(row.id) === result.externalRef);
    expect(created).toBeDefined();
    expect(created?.customer).toBe('Composed Holdings');
  }, 120_000);

  it('refuses a plan whose controls this memory version does not hold', async () => {
    const result = await materialize(
      createJob({
        values: [
          {
            field: 'customer',
            controlElementKey: 'orders-new.create-order.nonexistent',
            value: 'x',
          },
        ],
      }),
      dependencies(),
    );

    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toContain('orders-new.create-order.nonexistent');
    expect(result.failureReason).toContain('different version');
  }, 60_000);

  it('reports a control that has vanished from the form rather than submitting a partial one', async () => {
    // A control the memory holds, on a screen the job does not navigate to: the fingerprint is
    // real and resolvable, but not on `/orders/new`. That is what a form losing a field looks
    // like from the adapter's side.
    const before = await ordersFromApi();

    const result = await materialize(
      createJob({
        values: [
          ...requiredValues('Never Written', 'PO-0003'),
          { field: 'delete', controlElementKey: deleteElementKey, value: 'x' },
        ],
      }),
      dependencies(),
    );

    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toContain('delete');
    expect(result.failureReason).toContain('re-index');

    // Nothing was submitted. A partially filled form must never reach the application.
    expect(await ordersFromApi()).toHaveLength(before.length);
  }, 60_000);
});

describe('reverting through the indexed delete flow', () => {
  it('removes the record it was given and leaves its neighbour alone', async () => {
    const keep = await materialize(
      createJob({ values: requiredValues('Keep Me Ltd', 'PO-0001') }),
      dependencies(),
    );
    const remove = await materialize(
      createJob({ values: requiredValues('Remove Me Ltd', 'PO-0002') }),
      dependencies(),
    );

    expect(keep.outcome).toBe('succeeded');
    expect(remove.outcome).toBe('succeeded');
    const removeRef = remove.externalRef ?? '';
    const removePath = remove.detailPath ?? '';
    const keepRef = keep.externalRef ?? '';

    const result = await materialize(
      {
        operation: 'ui_revert',
        jobId: randomUUID(),
        tenantId: fixture.tenantId,
        applicationId: fixture.applicationId,
        memoryVersionId,
        entity: 'Order',
        flow: deleteElementKey,
        externalRef: removeRef,
        detailPath: removePath,
        deadlineMs: 60_000,
      },
      dependencies(),
    );

    expect(result.failureReason).toBeNull();
    expect(result.outcome).toBe('succeeded');

    const remaining = await ordersFromApi();
    expect(remaining.map((row) => String(row.id))).not.toContain(removeRef);
    // The claim that matters: one row of many identical delete buttons was pressed, and it was
    // the right one.
    expect(remaining.map((row) => String(row.id))).toContain(keepRef);
  }, 180_000);

  it('treats a record that is already gone as reverted', async () => {
    const created = await materialize(createJob(), dependencies());
    expect(created.outcome).toBe('succeeded');

    const revertJob: UiJob = {
      operation: 'ui_revert',
      jobId: randomUUID(),
      tenantId: fixture.tenantId,
      applicationId: fixture.applicationId,
      memoryVersionId,
      entity: 'Order',
      flow: deleteElementKey,
      externalRef: created.externalRef ?? '',
      detailPath: created.detailPath ?? '',
      deadlineMs: 60_000,
    };

    expect((await materialize(revertJob, dependencies())).outcome).toBe('succeeded');

    // Again, against a record that no longer exists. A revert is idempotent because its
    // post-condition — the record is not there — already holds.
    const second = await materialize(revertJob, dependencies());
    expect(second.outcome).toBe('succeeded');
    expect(second.failureReason).toBeNull();
  }, 180_000);
});

/**
 * A create job for the API adapter, built from the materializer the crawl actually inferred.
 *
 * The spec is read out of the database rather than written here, because the point of the suite is
 * that observation produced something replayable. A hand-written path and payload would pass even
 * if `inferApiMaterializers` had learned nothing at all.
 */
function apiCreateJob(overrides: Partial<HttpJob<'api_create'>> = {}): HttpJob<'api_create'> {
  const learned = order.materializers.find((candidate) => candidate.kind === 'api');
  if (learned === undefined) {
    throw new Error(
      `the crawl inferred no API materializer for Order; kinds: ${order.materializers
        .map((candidate) => candidate.kind)
        .join(', ')}`,
    );
  }

  const spec = learned.spec as {
    method: 'POST' | 'PUT' | 'PATCH';
    path: string;
    readBackPath: string | null;
  };

  return {
    operation: 'api_create',
    jobId: randomUUID(),
    tenantId: fixture.tenantId,
    applicationId: fixture.applicationId,
    memoryVersionId,
    sessionId: randomUUID(),
    planId: randomUUID(),
    nodeId: 'order-1',
    entity: 'Order',
    method: spec.method,
    path: spec.path,
    // What the gateway's adapter produces by filling the observed template. Composed here because
    // the filling itself is the gateway's job and is tested there.
    payload: {
      accountId,
      customer: 'Replayed Holdings',
      po_number: 'PO-7781',
      status: 'pending',
      terms: 'net30',
      notes: '',
      lines: [{ sku: 'W-1', quantity: 2, amount: 400 }],
    },
    readBackPath: spec.readBackPath,
    deadlineMs: 60_000,
    ...overrides,
  };
}

describe('creating a record through the observed API', () => {
  it('replays the create the crawl observed, and reads the record back to prove it', async () => {
    const before = await ordersFromApi();
    const job = apiCreateJob();

    // The materializer under test was inferred, not configured: the crawl saw the create form's
    // priced preview go out and matched its payload against the form's own fields.
    expect(job.path).toBe('/api/v2/orders');
    expect(job.readBackPath).toBe('/api/v2/orders/:id');

    const result = await materializeOverHttp(job, dependencies());

    expect(result.failureReason).toBeNull();
    expect(result.outcome).toBe('succeeded');
    expect(result.externalRef).not.toBeNull();
    // An API replay learns an identifier and nothing about where the record is rendered.
    expect(result.detailPath).toBeNull();

    // The application's own account of what exists, not the adapter's.
    const after = await ordersFromApi();
    expect(after).toHaveLength(before.length + 1);
    expect(after.map((row) => String(row.id))).toContain(result.externalRef);
    expect(after.find((row) => String(row.id) === result.externalRef)?.customer).toBe(
      'Replayed Holdings',
    );
  }, 180_000);

  it('is the reason verification exists: the observed request, as observed, wrote nothing', async () => {
    // The only create the crawl could observe is the form's dry run — `X-Dry-Run` makes the
    // fixture compute a price and return without writing. The inferred materializer therefore
    // replays a request that, exactly as seen, is a no-op. `MaterializerSpec` stores no headers,
    // so the replay omits it and does write.
    //
    // Both outcomes return 201 with a body. Reading the record back is the only thing that tells
    // them apart, which is why a create with no observed read-back can never be marked verified.
    const before = await ordersFromApi();

    const dryRun = await fetch(`${app.url}/api/v2/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dry-run': '1' },
      body: JSON.stringify(apiCreateJob().payload),
    });
    expect(dryRun.status).toBe(200);
    expect(await ordersFromApi()).toHaveLength(before.length);

    const result = await materializeOverHttp(apiCreateJob(), dependencies());
    expect(result.outcome).toBe('succeeded');
    expect(await ordersFromApi()).toHaveLength(before.length + 1);
  }, 180_000);

  it('fails with the status when the application rejects the payload', async () => {
    const result = await materializeOverHttp(
      apiCreateJob({ path: '/api/v2/orders/nope/nowhere' }),
      dependencies(),
    );

    expect(result.outcome).toBe('failed');
    expect(result.externalRef).toBeNull();
    expect(result.failureReason).toContain('404');
    // The endpoint and the status, never the response body — that is a customer's data, and this
    // reason reaches the ledger and the HUD.
    expect(result.failureReason).toContain('/api/v2/orders/nope/nowhere');
  }, 120_000);

  it('reports a create it cannot read back rather than claiming success', async () => {
    // A read-back aimed at an endpoint that answers 404 for everything. The record *was* created;
    // what the adapter cannot do is prove it, and § 4 makes proof the precondition for running
    // ahead of the UI adapter.
    const result = await materializeOverHttp(
      apiCreateJob({ readBackPath: '/api/v2/accounts/:id' }),
      dependencies(),
    );

    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toContain('could not be read back');
  }, 120_000);

  it('refuses a read-back path it cannot address unambiguously', async () => {
    const result = await materializeOverHttp(
      apiCreateJob({ readBackPath: '/api/v2/accounts/:accountId/orders/:id' }),
      dependencies(),
    );

    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toContain('2 identifiers');
  }, 120_000);

  it('refuses to leave the application it was registered for', async () => {
    const result = await materializeOverHttp(
      apiCreateJob({ path: 'http://169.254.169.254/latest/meta-data/' }),
      dependencies(),
    );

    expect(result.outcome).toBe('failed');
    expect(result.externalRef).toBeNull();
  }, 120_000);
});

describe("creating a record through the customer's seeding endpoint", () => {
  function fixtureJobFor(command: string): HttpJob<'fixture_create'> {
    return {
      operation: 'fixture_create',
      jobId: randomUUID(),
      tenantId: fixture.tenantId,
      applicationId: fixture.applicationId,
      memoryVersionId,
      sessionId: randomUUID(),
      planId: randomUUID(),
      nodeId: 'order-1',
      entity: 'Order',
      command,
      payload: {
        accountId,
        customer: 'Sanctioned Holdings',
        po_number: 'PO-9002',
        status: 'pending',
        terms: 'net30',
        notes: '',
        lines: [{ sku: 'W-2', quantity: 1, amount: 250 }],
      },
      deadlineMs: 60_000,
    };
  }

  it('posts the composed record to the configured endpoint', async () => {
    const before = await ordersFromApi();

    const result = await materializeOverHttp(fixtureJobFor('/__seed/orders'), dependencies());

    expect(result.failureReason).toBeNull();
    expect(result.outcome).toBe('succeeded');

    const after = await ordersFromApi();
    expect(after).toHaveLength(before.length + 1);
    expect(after.find((row) => String(row.id) === result.externalRef)?.customer).toBe(
      'Sanctioned Holdings',
    );
  }, 120_000);

  it('runs the configured teardown, and treats an already-gone record as reverted', async () => {
    const created = await materializeOverHttp(fixtureJobFor('/__seed/orders'), dependencies());
    expect(created.outcome).toBe('succeeded');
    const ref = created.externalRef ?? '';

    const revertJob: HttpJob<'fixture_revert'> = {
      operation: 'fixture_revert',
      jobId: randomUUID(),
      tenantId: fixture.tenantId,
      applicationId: fixture.applicationId,
      memoryVersionId,
      entity: 'Order',
      externalRef: ref,
      command: '/__seed/orders/teardown',
      deadlineMs: 60_000,
    };

    expect((await materializeOverHttp(revertJob, dependencies())).outcome).toBe('succeeded');
    expect((await ordersFromApi()).map((row) => String(row.id))).not.toContain(ref);

    // The endpoint answers 404 the second time. A revert is idempotent because its post-condition
    // — the record is not there — already holds.
    const second = await materializeOverHttp(revertJob, dependencies());
    expect(second.outcome).toBe('succeeded');
    expect(second.failureReason).toBeNull();
  }, 180_000);

  it('refuses a seeding endpoint outside the application, rather than calling it', async () => {
    // The single most important refusal in this module: `command` is a database column, and a
    // fixture adapter that dialled whatever it held would be an allowlist bypass reachable
    // through configuration. A customer whose seeder lives on another host cannot use it yet,
    // and finding that out here is the correct outcome.
    const result = await materializeOverHttp(
      fixtureJobFor('http://169.254.169.254/latest/meta-data/'),
      dependencies(),
    );

    expect(result.outcome).toBe('failed');
    expect(result.externalRef).toBeNull();
  }, 120_000);
});
