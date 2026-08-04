import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { pino } from 'pino';
import type { Browser } from 'playwright';
import type { UiSeedJob } from 'protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchBrowser } from '../../src/crawl/browser.js';
import { createSecretResolver } from '../../src/crawl/secrets.js';
import { createTenantDatabase, type TenantDatabase } from '../../src/db/pool.js';
import { runJob } from '../../src/job-runner.js';
import { createRedis } from '../../src/redis/client.js';
import type { MaterializerDependencies } from '../../src/seed/materializer.js';
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
 * The UI materializer, against a real application.
 *
 * The half of docs/BUILD-PLAN.md Phase 15 that lives in this service. Nothing is mocked: a real
 * browser crawls a real Express application to build the memory, and then a second browser
 * session drives that application's own create form using nothing but the fingerprints the crawl
 * stored. The record it creates is asserted against the application's own API, not against
 * anything the adapter reported about itself.
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
function createJob(
  overrides: Partial<Extract<UiSeedJob, { operation: 'create' }>> = {},
): UiSeedJob {
  return {
    operation: 'create',
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
function requiredValues(
  customer: string,
  poNumber: string,
): Extract<UiSeedJob, { operation: 'create' }>['values'] {
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
        operation: 'revert',
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

    const revertJob: UiSeedJob = {
      operation: 'revert',
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
