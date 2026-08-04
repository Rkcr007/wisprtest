import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { pino } from 'pino';
import type { Browser } from 'playwright';
import { CrawlJob, IndexProgressEvent } from 'protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { launchBrowser } from '../../src/crawl/browser.js';
import { createSecretResolver } from '../../src/crawl/secrets.js';
import { createTenantDatabase, type TenantDatabase } from '../../src/db/pool.js';
import { runJob, type JobRunnerDependencies } from '../../src/job-runner.js';
import { createRedis } from '../../src/redis/client.js';
import { progressStreamKey } from '../../src/redis/progress.js';
import { createMetrics } from '../../src/telemetry/metrics.js';
import { startFixtureApp, type FixtureApp } from '../fixture-app/server.js';
import {
  createFixture,
  fixtureBounds,
  fixtureJob,
  readMemory,
  testConfig,
  waitFor,
  type Fixture,
} from '../support/harness.js';

/**
 * The crawl, end to end, against a real application.
 *
 * What is asserted here is not "the crawler ran". It is that a specific application produced a
 * specific memory: five screens with the route patterns you would name yourself, elements keyed
 * legibly, edges between screens that were observed rather than inferred — and, just as
 * importantly, that nothing in the application changed while all of that happened.
 */

const config = testConfig();

let browser: Browser;
let database: TenantDatabase;
let redis: Redis;
let app: FixtureApp;
let fixture: Fixture;

const logger = pino({ level: config.LOG_LEVEL });

beforeAll(async () => {
  browser = await launchBrowser(true);
  database = createTenantDatabase(config);
  redis = createRedis(config);
  await redis.connect();
}, 120_000);

afterAll(async () => {
  await browser.close();
  await database.close();
  await redis.quit();
});

beforeAll(async () => {
  app = await startFixtureApp();
  fixture = await createFixture(app.url);
});

afterAll(async () => {
  await fixture.drop();
  await app.close();
});

function dependencies(): JobRunnerDependencies {
  return {
    database,
    redis,
    browser,
    secrets: createSecretResolver(),
    metrics: createMetrics(),
    logger,
    progressMaxLength: config.INDEXER_PROGRESS_MAXLEN,
  };
}

async function progressEvents(tenantId: string, jobId: string): Promise<IndexProgressEvent[]> {
  const entries = await redis.xrange(progressStreamKey(tenantId, jobId), '-', '+');
  return entries.map(([, fields]) => {
    const index = fields.indexOf('event');
    return IndexProgressEvent.parse(JSON.parse(fields[index + 1] ?? '{}'));
  });
}

describe('crawling the fixture application', () => {
  it('produces a memory version with the expected screens, elements and edges', async () => {
    const job = fixtureJob(fixture, app.url, fixtureBounds(app.url));

    const outcome = await runJob(job, dependencies(), new AbortController().signal);
    expect(outcome.status).toBe('completed');

    const memory = await readMemory(fixture.client, fixture.applicationId);
    expect(memory).not.toBeNull();
    if (memory === null) throw new Error('unreachable');

    // ── The version itself ──────────────────────────────────────────────────────────────────
    expect(memory.version.status).toBe('active');
    expect(memory.version.version).toBe(1);
    expect(memory.version.failureReason).toBeNull();

    // ── Screens: five routes, with the identifier generalised ───────────────────────────────
    expect(memory.screens.map((screen) => screen.routePattern)).toEqual([
      '/',
      '/orders',
      '/orders/:id',
      '/orders/new',
      '/settings',
    ]);
    // Three concrete orders are linked from the table; all three are one screen.
    expect(memory.screens.filter((screen) => screen.routePattern === '/orders/:id')).toHaveLength(
      1,
    );

    // Labels are derived from the route, never from the page title — a title here would read
    // "Northwind — Order 1841", which names a customer's order.
    expect(memory.screens.map((screen) => screen.label)).toEqual([
      'Home',
      'Orders',
      'Orders detail',
      'Orders new',
      'Settings',
    ]);

    // ── Elements: keyed as screen.component.element ─────────────────────────────────────────
    const keys = memory.elements.map((element) => element.elementKey);
    expect(keys.every((key) => /^[a-z0-9-]+(\.[a-z0-9-]+){2}$/.test(key))).toBe(true);

    // The create form's controls, named by the form they sit in and the field names they carry.
    expect(keys).toContain('orders-new.create-order.customer');
    expect(keys).toContain('orders-new.create-order.amount');
    expect(keys).toContain('orders-new.create-order.status');
    expect(keys).toContain('orders-new.create-order.order-create');

    // Landmark ancestry names the component: two forms on the settings screen, two components.
    expect(keys).toContain('settings.notification-settings.settings-save');
    expect(keys).toContain('settings.danger-zone.settings-purge');

    // `/orders` and `/orders/:id` are different screens and their keys say so, rather than both
    // claiming the `orders.` prefix.
    expect(keys).toContain('orders-detail.form.order-approve');
    expect(keys.filter((key) => key.startsWith('orders.form.order-delete'))).toHaveLength(4);

    // Repeated controls in a table take an ordinal suffix rather than colliding.
    expect(keys.filter((key) => key.startsWith('orders.orders.view'))).toEqual([
      'orders.orders.view',
      'orders.orders.view-2',
      'orders.orders.view-3',
      'orders.orders.view-4',
    ]);

    // ── Fingerprints carry structure, not content ───────────────────────────────────────────
    const createButton = memory.elements.find(
      (element) => element.elementKey === 'orders-new.create-order.order-create',
    );
    expect(createButton?.role).toBe('button');
    const fingerprint = createButton?.fingerprint as {
      accessibleNameRedacted: string;
      stableAttributes: Record<string, string>;
      landmarkPath: string[];
    };
    expect(fingerprint.accessibleNameRedacted).toBe('Create order');
    expect(fingerprint.stableAttributes['data-testid']).toBe('order-create');
    // The marker attribute the crawler stamps is invisible to fingerprinting.
    expect(Object.keys(fingerprint.stableAttributes)).not.toContain('data-wispr-el');

    // ── Edges: observed by clicking, not read off href attributes ───────────────────────────
    const byId = new Map(memory.screens.map((screen) => [screen.id, screen.routePattern]));
    const edges = memory.edges.map((edge) => ({
      from: byId.get(edge.fromScreen),
      to: byId.get(edge.toScreen),
    }));
    expect(edges).toContainEqual({ from: '/', to: '/orders' });
    expect(edges).toContainEqual({ from: '/orders', to: '/orders/:id' });
    expect(edges).toContainEqual({ from: '/', to: '/settings' });

    // Every edge names the element that caused it, and that element exists.
    const elementIds = new Set(
      (
        await fixture.client.query<{ id: string }>(
          'SELECT e.id FROM elements e JOIN screens s ON s.id = e.screen_id WHERE s.memory_version_id = $1',
          [memory.version.id],
        )
      ).rows.map((row) => row.id),
    );
    for (const edge of memory.edges) expect(elementIds.has(edge.triggerElement)).toBe(true);

    // ── The application is untouched ────────────────────────────────────────────────────────
    // No order created, deleted or approved, no settings saved. A crawl that submits a form or
    // presses a prohibited control fails here, which is the assertion this whole fixture exists
    // to support.
    expect(app.state.mutations).toEqual([]);
    // Fifty in the ledger; the table renders the four most recent, which is why the row controls
    // above still come to four.
    expect(app.state.orders).toHaveLength(50);

    // ── Progress was streamed for the console to read ───────────────────────────────────────
    const events = await progressEvents(fixture.tenantId, job.jobId);
    expect(events[0]?.kind).toBe('job_started');
    expect(events.at(-1)?.kind).toBe('job_completed');
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index));
    expect(events.filter((event) => event.kind === 'route_indexed')).toHaveLength(5);

    const completed = events.at(-1);
    if (completed?.kind !== 'job_completed') throw new Error('expected a completion event');
    expect(completed.screenCount).toBe(5);
    expect(completed.elementCount).toBe(memory.elements.length);
    expect(completed.edgeCount).toBe(memory.edges.length);
  }, 180_000);
});

describe('bounds and target validation', () => {
  let scoped: Fixture | undefined;

  afterEach(async () => {
    await scoped?.drop();
    scoped = undefined;
  });

  it('fails a job whose origin allowlist does not include the application', async () => {
    const fx = await createFixture(app.url);
    scoped = fx;
    const bounds = fixtureBounds(app.url, { allowedOrigins: ['https://elsewhere.example'] });
    const job = fixtureJob(fx, app.url, bounds);

    const outcome = await runJob(job, dependencies(), new AbortController().signal);

    expect(outcome.status).toBe('failed');
    expect(outcome.failure?.code).toBe('bounds_invalid');

    // No memory version at all: the bounds are checked before one is opened, so a rejected job
    // leaves nothing behind for an operator to clean up.
    expect(outcome.memoryVersionId).toBeNull();
    expect(await readMemory(fx.client, fx.applicationId)).toBeNull();

    // The console still learns why, from the progress stream.
    const events = await progressEvents(fx.tenantId, job.jobId);
    const failure = events.at(-1);
    if (failure?.kind !== 'job_failed') throw new Error('expected a failure event');
    expect(failure.code).toBe('bounds_invalid');
    expect(failure.memoryVersionId).toBeNull();
  }, 60_000);

  it('refuses a job that points somewhere other than the registered application', async () => {
    const fx = await createFixture(app.url);
    scoped = fx;
    // A job that passes schema validation in every respect, and names a different host.
    const elsewhere = 'https://orders.attacker.example';
    const job = fixtureJob(fx, elsewhere, fixtureBounds(elsewhere));

    const outcome = await runJob(job, dependencies(), new AbortController().signal);

    expect(outcome.status).toBe('failed');
    expect(outcome.failure?.code).toBe('ssrf_rejected');
    // Nothing was dialled and nothing was written: the check happens before the browser opens.
    expect(await readMemory(fx.client, fx.applicationId)).toBeNull();
  }, 60_000);

  it('skips routes outside the route allowlist instead of visiting them', async () => {
    const fx = await createFixture(app.url);
    scoped = fx;
    const bounds = fixtureBounds(app.url, { routeAllowlist: ['/orders'] });
    const job = fixtureJob(fx, `${app.url}/orders`, bounds);

    const outcome = await runJob(job, dependencies(), new AbortController().signal);
    expect(outcome.status).toBe('completed');

    const memory = await readMemory(fx.client, fx.applicationId);
    const patterns = memory?.screens.map((screen) => screen.routePattern) ?? [];
    expect(patterns).toContain('/orders');
    expect(patterns).not.toContain('/settings');
    expect(patterns).not.toContain('/');

    // Links the crawl declined are reported, not dropped quietly: a half-indexed application and
    // a small one are indistinguishable unless the skips are on the record.
    const events = await progressEvents(fx.tenantId, job.jobId);
    const skipped = events.filter((event) => event.kind === 'route_skipped');
    expect(skipped.map((event) => event.reason)).toContain('off_allowlist');
  }, 120_000);
});

describe('resumability', () => {
  let scoped: Fixture | undefined;

  afterEach(async () => {
    await scoped?.drop();
    scoped = undefined;
  });

  it('continues a crashed job from the last completed route', async () => {
    const fx = await createFixture(app.url);
    scoped = fx;
    const job = fixtureJob(fx, app.url, fixtureBounds(app.url));

    // First attempt: cancelled as soon as one route has been written, which is what a worker
    // being told to shut down mid-crawl looks like from the job's point of view.
    const controller = new AbortController();
    const firstAttempt = runJob(job, dependencies(), controller.signal);

    await waitFor('the first screen to be persisted', async () => {
      const memory = await readMemory(fx.client, fx.applicationId);
      return (memory?.screens.length ?? 0) >= 1;
    });
    controller.abort();

    const cancelled = await firstAttempt;
    expect(cancelled.status).toBe('cancelled');

    const partial = await readMemory(fx.client, fx.applicationId);
    // Left `building`, not `failed`: the work is unfinished, not wrong.
    expect(partial?.version.status).toBe('building');
    const partialScreens = partial?.screens.length ?? 0;
    expect(partialScreens).toBeGreaterThanOrEqual(1);
    expect(partialScreens).toBeLessThan(5);

    // Second attempt: the same job, as a reclaiming worker would run it.
    const resumed = await runJob(job, dependencies(), new AbortController().signal);
    expect(resumed.status).toBe('completed');

    const memory = await readMemory(fx.client, fx.applicationId);
    expect(memory?.version.status).toBe('active');
    // The same version was continued rather than a second one opened.
    expect(memory?.version.version).toBe(1);
    expect(memory?.version.id).toBe(partial?.version.id);
    expect(memory?.screens.map((screen) => screen.routePattern)).toEqual([
      '/',
      '/orders',
      '/orders/:id',
      '/orders/new',
      '/settings',
    ]);

    const events = await progressEvents(fx.tenantId, job.jobId);
    const starts = events.filter((event) => event.kind === 'job_started');
    expect(starts).toHaveLength(2);
    expect(starts[0]?.kind === 'job_started' && starts[0].resumed).toBe(false);
    expect(starts[1]?.kind === 'job_started' && starts[1].resumed).toBe(true);

    // The resumed run did not re-index what the first one had already written.
    const reindexed = events.filter((event) => event.kind === 'route_indexed');
    expect(reindexed).toHaveLength(5);
  }, 180_000);
});

describe('memory versions', () => {
  let scoped: Fixture | undefined;

  afterEach(async () => {
    await scoped?.drop();
    scoped = undefined;
  });

  it('supersedes the previous active version and records element stability', async () => {
    const fx = await createFixture(app.url);
    scoped = fx;
    const bounds = fixtureBounds(app.url, { routeAllowlist: ['/settings'], maxDepth: 0 });

    const first = await runJob(
      fixtureJob(fx, `${app.url}/settings`, bounds),
      dependencies(),
      new AbortController().signal,
    );
    expect(first.status).toBe('completed');

    const second = await runJob(
      fixtureJob(fx, `${app.url}/settings`, bounds),
      dependencies(),
      new AbortController().signal,
    );
    expect(second.status).toBe('completed');

    const versions = await fx.client.query<{ version: number; status: string }>(
      'SELECT version, status FROM memory_versions WHERE application_id = $1 ORDER BY version',
      [fx.applicationId],
    );
    expect(versions.rows).toEqual([
      { version: 1, status: 'superseded' },
      { version: 2, status: 'active' },
    ]);

    // Stability is evidence, not an assumption: zero on a first index because nothing has
    // re-resolved yet, one on the second because the same element key resolved again.
    const stability = await fx.client.query<{ stability: string; version: number }>(
      `SELECT e.stability, v.version
         FROM elements e
         JOIN screens s ON s.id = e.screen_id
         JOIN memory_versions v ON v.id = s.memory_version_id
        WHERE v.application_id = $1 AND e.element_key = 'settings.notification-settings.settings-save'
        ORDER BY v.version`,
      [fx.applicationId],
    );
    expect(stability.rows.map((row) => [row.version, Number(row.stability)])).toEqual([
      [1, 0],
      [2, 1],
    ]);
  }, 180_000);
});

describe('the job stream', () => {
  let scoped: Fixture | undefined;

  afterEach(async () => {
    await scoped?.drop();
    scoped = undefined;
  });

  it('consumes a published job, acknowledges it, and leaves the queue empty', async () => {
    const { createJobStream } = await import('../../src/redis/job-stream.js');
    const { createWorker } = await import('../../src/worker.js');

    const fx = await createFixture(app.url);
    scoped = fx;
    const streamName = `indexer:test:jobs:${randomUUID()}`;
    const stream = createJobStream(redis, CrawlJob, {
      stream: streamName,
      group: 'indexers',
      consumer: 'worker-under-test',
      blockMs: 250,
      claimMinIdleMs: 60_000,
    });
    await stream.ensureGroup();

    const bounds = fixtureBounds(app.url, { routeAllowlist: ['/settings'], maxDepth: 0 });
    const job = fixtureJob(fx, `${app.url}/settings`, bounds);
    await stream.publish(job);

    const worker = createWorker({
      stream,
      database,
      redis,
      browser,
      secrets: createSecretResolver(),
      metrics: createMetrics(),
      logger,
      progressMaxLength: config.INDEXER_PROGRESS_MAXLEN,
    });

    const running = worker.run();
    await waitFor('the crawl to activate a memory version', async () => {
      const memory = await readMemory(fx.client, fx.applicationId);
      return memory?.version.status === 'active';
    });
    worker.stop();
    await running;

    // Acknowledged, so no other worker will reclaim it.
    const pending = (await redis.xpending(stream.key, 'indexers')) as [number, ...unknown[]];
    expect(pending[0]).toBe(0);

    await redis.del(stream.key);
  }, 180_000);
});
