import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { CrawlJob, IndexProgressEvent, type CrawlBounds } from 'protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { activeProgressReaders } from '../../src/redis/crawl-queue.js';
import { NEIGHBOUR, SEED, startHarness, type Harness } from '../support/harness.js';

/**
 * The crawl enqueue and index-progress routes, against the real stack.
 *
 * Two properties matter more than the rest here, and both are the kind that fail silently:
 *
 * 1. **The job has to land on the key the indexer actually reads.** The gateway namespaces keys
 *    through ioredis's `keyPrefix`; the indexer does it in code. A mismatch produces a 202, an
 *    entry in Redis, and a crawl that never runs. So the assertions below read the stream through
 *    a *second, unprefixed* client at the literal key `wispr:indexer:jobs`, and parse the entry's
 *    `job` field with the contract — exactly what the worker does.
 * 2. **A progress stream must not leak across tenants, and must not leak connections.** Both are
 *    asserted directly: one tenant publishing progress, another asking for the same job id and
 *    receiving nothing; and a client that disconnects mid-stream leaving zero readers behind.
 *
 * The suite listens on a real port. `app.inject` buffers a response to completion, so an SSE
 * endpoint — which by definition does not complete — cannot be exercised through it.
 */

let harness: Harness;
/** A second connection with no `keyPrefix`, so keys are asserted at their true, literal names. */
let raw: Redis;
let baseUrl: string;
/** Stream entries this suite added, removed in `afterAll` so a rerun starts clean. */
const enqueued: string[] = [];
const progressKeys = new Set<string>();
const suiteStartedAt = new Date();

/** The literal keys the indexer builds by hand in `apps/indexer/src/redis/client.ts`. */
const JOB_STREAM_KEY = 'wispr:indexer:jobs';
const LATEST_JOB_KEY = `wispr:tenant:${SEED.tenantId}:indexer:job:${SEED.applicationId}`;

function progressKey(tenantId: string, jobId: string): string {
  return `wispr:tenant:${tenantId}:indexer:progress:${jobId}`;
}

/** Bounds that satisfy the contract and cover the seed application's registered origin. */
const BOUNDS: CrawlBounds = {
  allowedOrigins: ['https://orders.northwind.example'],
  routeAllowlist: ['/orders'],
  maxDepth: 2,
  maxPages: 25,
  neverInteractSelectors: ['[data-testid="order-delete"]'],
  maxInteractionsPerRoute: 8,
  interactionObserveMs: 1_000,
  settleDelayMs: 250,
  networkIdleTimeoutMs: 5_000,
  navigationTimeoutMs: 20_000,
  requestsPerMinute: 60,
  viewport: { width: 1280, height: 720 },
};

const AUTH_PROFILE = {
  kind: 'form',
  loginPath: '/login',
  usernameLabel: 'Email address',
  passwordLabel: 'Password',
  submitLabel: 'Sign in',
  credentialsRef: { provider: 'env', key: 'NORTHWIND_CRAWLER_CREDENTIALS' },
  successPath: '/orders',
} as const;

const HASH = 'a'.repeat(64);

beforeAll(async () => {
  harness = await startHarness();
  // A real socket, not `inject`: the progress route streams and never completes.
  baseUrl = await harness.app.listen({ port: 0, host: '127.0.0.1' });
  raw = new Redis(harness.config.REDIS_URL);
  // Start from no pointer, so the "nothing to follow" case is the first thing asserted rather
  // than a leftover from a previous run.
  await raw.del(LATEST_JOB_KEY);
});

afterAll(async () => {
  if (enqueued.length > 0) await raw.xdel(JOB_STREAM_KEY, ...enqueued);
  for (const key of progressKeys) await raw.del(key);
  await raw.del(LATEST_JOB_KEY);
  raw.disconnect();

  await harness.database.unscoped('readiness-probe', (db) =>
    db
      .deleteFrom('auditLog')
      .where('action', '=', 'application.crawl_enqueued')
      .where('createdAt', '>=', suiteStartedAt)
      .execute(),
  );

  await harness.close();
});

async function post(email: string, applicationId: string, body: unknown) {
  const token = await harness.issuer.sign({ email });
  const response = await fetch(`${baseUrl}/v1/applications/${applicationId}/crawl`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Enqueue a crawl that is expected to succeed, and remember its entry for cleanup. */
async function enqueueCrawl(): Promise<{ jobId: string; messageId: string }> {
  const response = await post(SEED.leadEmail, SEED.applicationId, {
    bounds: BOUNDS,
    authProfile: AUTH_PROFILE,
  });
  expect(response.status).toBe(202);

  const jobId = z.uuid().parse(response.body.jobId);
  const messageId = z.string().parse(response.body.messageId);
  enqueued.push(messageId);
  return { jobId, messageId };
}

/** Publish one event as the indexer does: field `event`, JSON payload, tenant-scoped stream. */
async function publish(tenantId: string, jobId: string, event: IndexProgressEvent): Promise<void> {
  const key = progressKey(tenantId, jobId);
  progressKeys.add(key);
  await raw.xadd(key, '*', 'event', JSON.stringify(IndexProgressEvent.parse(event)));
}

function jobStarted(tenantId: string, jobId: string, sequence: number): IndexProgressEvent {
  return {
    kind: 'job_started',
    jobId,
    tenantId,
    sequence,
    at: new Date().toISOString(),
    memoryVersionId: SEED.memoryVersionId,
    version: 2,
    resumed: false,
  };
}

function routeIndexed(tenantId: string, jobId: string, sequence: number): IndexProgressEvent {
  return {
    kind: 'route_indexed',
    jobId,
    tenantId,
    sequence,
    at: new Date().toISOString(),
    screenId: randomUUID(),
    routePattern: '/orders',
    stateFingerprint: HASH,
    elementCount: 14,
    durationMs: 812,
  };
}

function jobCompleted(tenantId: string, jobId: string, sequence: number): IndexProgressEvent {
  return {
    kind: 'job_completed',
    jobId,
    tenantId,
    sequence,
    at: new Date().toISOString(),
    memoryVersionId: SEED.memoryVersionId,
    screenCount: 1,
    elementCount: 14,
    edgeCount: 0,
    durationMs: 4_200,
  };
}

interface SseFrame {
  readonly id: string | null;
  readonly event: string | null;
  readonly data: string | null;
}

/** Parse one `\n\n`-delimited SSE block. Comment lines (`: keep-alive`) yield no fields. */
function parseFrame(block: string): SseFrame {
  let id: string | null = null;
  let event: string | null = null;
  let data: string | null = null;

  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator);
    const value = line.slice(separator + 1).trimStart();
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data = value;
  }

  return { id, event, data };
}

interface ReadOptions {
  readonly until?: (frames: SseFrame[]) => boolean;
  /** Read for this long when `until` is absent or never satisfied, then disconnect. */
  readonly forMs?: number;
  readonly lastEventId?: string;
  /** Called once the response headers arrive, before any frame is read. */
  readonly onOpen?: (abort: () => void) => void;
}

/** Open the progress stream, collect frames, then disconnect — as a console tab would. */
async function readProgress(
  applicationId: string,
  email: string,
  query: string,
  options: ReadOptions = {},
): Promise<{ status: number; contentType: string | null; frames: SseFrame[] }> {
  const token = await harness.issuer.sign({ email });
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort();
  }, options.forMs ?? 20_000);

  const frames: SseFrame[] = [];
  try {
    const response = await fetch(
      `${baseUrl}/v1/applications/${applicationId}/index-progress${query}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'text/event-stream',
          ...(options.lastEventId === undefined ? {} : { 'last-event-id': options.lastEventId }),
        },
        signal: controller.signal,
      },
    );

    const contentType = response.headers.get('content-type');
    if (response.status !== 200 || response.body === null) {
      return { status: response.status, contentType, frames };
    }

    options.onOpen?.(() => {
      controller.abort();
    });

    // Annotated rather than inferred: without a DOM lib the global `ReadableStream` is generic
    // over `any`, and an untyped chunk would silently defeat the decode below.
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // `for (;;)` rather than `while (true)`: the exit is the reader reporting `done`, and a
    // literal condition reads to the linter as a loop that can never end.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.length > 0) frames.push(parseFrame(block));
        boundary = buffer.indexOf('\n\n');
      }

      if (options.until?.(frames) === true) {
        controller.abort();
        break;
      }
    }

    return { status: response.status, contentType, frames };
  } catch (error: unknown) {
    // An abort is how this function stops on purpose; anything else is a real failure.
    if (error instanceof Error && error.name === 'AbortError') {
      return { status: 200, contentType: 'text/event-stream; charset=utf-8', frames };
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

/** Wait for a condition, polling. Used for the reader-count assertion after a disconnect. */
async function eventually(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

describe('POST /v1/applications/:id/crawl', () => {
  it('enqueues a contract-valid job on the stream the indexer reads', async () => {
    const { jobId, messageId } = await enqueueCrawl();

    // Read back through the unprefixed client, at the literal key. This is the assertion that
    // the two services' key namespacing agrees; everything else could pass with them disagreeing.
    const entries = await raw.xrange(JOB_STREAM_KEY, messageId, messageId);
    expect(entries).toHaveLength(1);

    const fields = entries[0]?.[1] ?? [];
    // Field layout from `apps/indexer/src/redis/job-stream.ts`: one field, `job`, holding JSON.
    expect(fields[0]).toBe('job');

    const job = CrawlJob.parse(JSON.parse(fields[1] ?? 'null'));
    expect(job.jobId).toBe(jobId);
    expect(job.tenantId).toBe(SEED.tenantId);
    expect(job.applicationId).toBe(SEED.applicationId);
    // Read from the applications row, never from the request body.
    expect(job.baseUrl).toBe('https://orders.northwind.example');
    expect(job.bounds).toEqual(BOUNDS);
    expect(job.authProfile).toEqual(AUTH_PROFILE);
    expect(job.requestedBy).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('remembers the job as the application’s current one, under a tenant-scoped key', async () => {
    const { jobId } = await enqueueCrawl();

    expect(await raw.get(LATEST_JOB_KEY)).toBe(jobId);
    // Expiring, and no longer than the indexer retains the progress stream it points at.
    const ttl = await raw.ttl(LATEST_JOB_KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60);
  });

  it('audits the request without recording where the credentials live', async () => {
    const { jobId } = await enqueueCrawl();

    const row = await harness.database.unscoped('readiness-probe', (db) =>
      db
        .selectFrom('auditLog')
        .select(['actor', 'action', 'target', 'metadata'])
        .where('action', '=', 'application.crawl_enqueued')
        .where('tenantId', '=', SEED.tenantId)
        .orderBy('createdAt', 'desc')
        .executeTakeFirst(),
    );

    expect(row?.action).toBe('application.crawl_enqueued');
    expect(row?.target).toBe(`application:${SEED.applicationId}`);
    expect(row?.actor).toMatch(/^user:[0-9a-f-]{36}$/);

    const metadata = z
      .object({
        jobId: z.uuid(),
        authProfileKind: z.string(),
        maxDepth: z.number(),
        maxPages: z.number(),
        neverInteractSelectorCount: z.number(),
      })
      .parse(row?.metadata);

    expect(metadata.jobId).toBe(jobId);
    expect(metadata.authProfileKind).toBe('form');
    expect(metadata.maxPages).toBe(BOUNDS.maxPages);
    expect(metadata.neverInteractSelectorCount).toBe(1);
    // The profile is recorded by kind. The secret reference names where a credential lives, and
    // an audit row is the last place that should be written down.
    expect(JSON.stringify(row?.metadata)).not.toContain('NORTHWIND_CRAWLER_CREDENTIALS');
  });

  it('refuses a crawl with no bounds at all', async () => {
    const response = await post(SEED.leadEmail, SEED.applicationId, {
      authProfile: { kind: 'none' },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('validation_failed');
    expect(JSON.stringify(response.body.issues)).toContain('bounds');
  });

  it.each([
    ['routeAllowlist', 'the route allowlist'],
    ['maxDepth', 'the depth cap'],
    ['maxPages', 'the page cap'],
    ['neverInteractSelectors', 'the never-interact list'],
  ])('refuses a crawl missing %s — %s', async (field) => {
    // Phase 5: "These bounds are config, and the crawl must refuse to start without them."
    const { [field as keyof CrawlBounds]: _removed, ...partial } = BOUNDS;

    const response = await post(SEED.leadEmail, SEED.applicationId, {
      bounds: partial,
      authProfile: { kind: 'none' },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('validation_failed');
    expect(JSON.stringify(response.body.issues)).toContain(`bounds.${field}`);
  });

  it('refuses an empty route allowlist, which would bound nothing', async () => {
    const response = await post(SEED.leadEmail, SEED.applicationId, {
      bounds: { ...BOUNDS, routeAllowlist: [] },
      authProfile: { kind: 'none' },
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body.issues)).toContain('bounds.routeAllowlist');
  });

  it('refuses bounds that do not allow the application’s own origin', async () => {
    const response = await post(SEED.leadEmail, SEED.applicationId, {
      bounds: { ...BOUNDS, allowedOrigins: ['https://somewhere.else.example'] },
      authProfile: { kind: 'none' },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('validation_failed');
    expect(JSON.stringify(response.body.issues)).toContain('bounds.allowedOrigins');
  });

  it('refuses a tester, and names the role they would need', async () => {
    // `application:register` floors at lead: a crawl drives a real browser against the customer's
    // application under the tenant's own login.
    const response = await post(SEED.testerEmail, SEED.applicationId, {
      bounds: BOUNDS,
      authProfile: { kind: 'none' },
    });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('forbidden');
    expect(response.body.requiredRole).toBe('lead');
  });

  it('does not enqueue against another tenant’s application', async () => {
    const before = await raw.xlen(JOB_STREAM_KEY);

    const response = await post(SEED.leadEmail, NEIGHBOUR.applicationId, {
      bounds: BOUNDS,
      authProfile: { kind: 'none' },
    });

    // Row-level security makes the neighbour's application invisible, so it reads as unknown —
    // the caller learns nothing about whether the id exists somewhere else.
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('validation_failed');
    expect(await raw.xlen(JOB_STREAM_KEY)).toBe(before);
  });

  it('is delivered to a consumer group created the way the indexer creates one', async () => {
    // The final word on the key question. `XGROUP CREATE … 0 MKSTREAM` is exactly what
    // `apps/indexer/src/redis/job-stream.ts` issues on boot, and `XREADGROUP … >` is how the
    // worker reads. If the gateway had written to a different key than the group is attached to,
    // this returns nothing — which is precisely the silent failure the namespacing comments warn
    // about, made loud.
    const group = `wispr-test-${randomUUID()}`;
    const { messageId } = await enqueueCrawl();

    await raw.xgroup('CREATE', JOB_STREAM_KEY, group, '0', 'MKSTREAM');
    try {
      const delivered = await raw.xreadgroup(
        'GROUP',
        group,
        'wispr-test-consumer',
        'COUNT',
        500,
        'STREAMS',
        JOB_STREAM_KEY,
        '>',
      );

      const entries = (delivered as [string, [string, string[]][]][] | null)?.[0]?.[1] ?? [];
      const ours = entries.find(([id]) => id === messageId);
      expect(ours).toBeDefined();
      expect(CrawlJob.parse(JSON.parse(ours?.[1]?.[1] ?? 'null')).applicationId).toBe(
        SEED.applicationId,
      );
    } finally {
      await raw.xgroup('DESTROY', JOB_STREAM_KEY, group);
    }
  });

  it('requires authentication', async () => {
    const response = await fetch(`${baseUrl}/v1/applications/${SEED.applicationId}/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bounds: BOUNDS, authProfile: { kind: 'none' } }),
    });

    expect(response.status).toBe(401);
  });
});

describe('GET /v1/applications/:id/index-progress', () => {
  it('streams the events the indexer published, and ends on completion', async () => {
    const { jobId } = await enqueueCrawl();

    await publish(SEED.tenantId, jobId, jobStarted(SEED.tenantId, jobId, 0));
    await publish(SEED.tenantId, jobId, routeIndexed(SEED.tenantId, jobId, 1));
    await publish(SEED.tenantId, jobId, jobCompleted(SEED.tenantId, jobId, 2));

    const result = await readProgress(SEED.applicationId, SEED.leadEmail, `?jobId=${jobId}`, {
      until: (frames) => frames.some((frame) => frame.event === 'end'),
    });

    expect(result.status).toBe(200);
    expect(result.contentType).toContain('text/event-stream');

    const events = result.frames.filter((frame) => frame.data !== null && frame.event !== 'end');
    expect(events.map((frame) => frame.event)).toEqual([
      'job_started',
      'route_indexed',
      'job_completed',
    ]);

    // Every frame parses as the contract's own union — the same schema the console will use.
    const parsed = events.map((frame) =>
      IndexProgressEvent.parse(JSON.parse(frame.data ?? 'null')),
    );
    expect(parsed.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(parsed.every((event) => event.jobId === jobId)).toBe(true);

    // The SSE id is the Redis stream id, which is what makes `Last-Event-ID` resumable.
    expect(events.every((frame) => /^\d+-\d+$/.test(frame.id ?? ''))).toBe(true);

    // The stream closes itself once the crawl is over rather than leaving `EventSource`
    // reconnecting to a finished job.
    expect(result.frames.at(-1)?.event).toBe('end');
  });

  it('resumes after Last-Event-ID rather than replaying from the start', async () => {
    const { jobId } = await enqueueCrawl();

    await publish(SEED.tenantId, jobId, jobStarted(SEED.tenantId, jobId, 0));
    await publish(SEED.tenantId, jobId, routeIndexed(SEED.tenantId, jobId, 1));
    await publish(SEED.tenantId, jobId, jobCompleted(SEED.tenantId, jobId, 2));

    const first = await readProgress(SEED.applicationId, SEED.leadEmail, `?jobId=${jobId}`, {
      until: (frames) => frames.some((frame) => frame.event === 'end'),
    });
    const firstId = first.frames.find((frame) => frame.event === 'job_started')?.id ?? '';
    expect(firstId).toMatch(/^\d+-\d+$/);

    const resumed = await readProgress(SEED.applicationId, SEED.leadEmail, `?jobId=${jobId}`, {
      lastEventId: firstId,
      until: (frames) => frames.some((frame) => frame.event === 'end'),
    });

    const kinds = resumed.frames
      .filter((frame) => frame.data !== null && frame.event !== 'end')
      .map((frame) => frame.event);
    expect(kinds).toEqual(['route_indexed', 'job_completed']);
  });

  it('follows the application’s current job when none is named', async () => {
    const { jobId } = await enqueueCrawl();
    await publish(SEED.tenantId, jobId, jobCompleted(SEED.tenantId, jobId, 0));

    const result = await readProgress(SEED.applicationId, SEED.leadEmail, '', {
      until: (frames) => frames.some((frame) => frame.event === 'end'),
    });

    const completed = result.frames.find((frame) => frame.event === 'job_completed');
    expect(completed).toBeDefined();
    expect(IndexProgressEvent.parse(JSON.parse(completed?.data ?? 'null')).jobId).toBe(jobId);
  });

  it('does not show another tenant’s progress for the same job id', async () => {
    // The neighbour is indexing, and the seed tenant asks for that exact job id. The stream key is
    // built from the *caller's* tenant, so there is nothing under it to read.
    const foreignJobId = randomUUID();
    await publish(
      NEIGHBOUR.tenantId,
      foreignJobId,
      jobStarted(NEIGHBOUR.tenantId, foreignJobId, 0),
    );
    await publish(
      NEIGHBOUR.tenantId,
      foreignJobId,
      jobCompleted(NEIGHBOUR.tenantId, foreignJobId, 1),
    );

    const result = await readProgress(
      SEED.applicationId,
      SEED.leadEmail,
      `?jobId=${foreignJobId}`,
      { forMs: 2_000 },
    );

    expect(result.status).toBe(200);
    expect(result.frames.filter((frame) => frame.data !== null)).toEqual([]);
  });

  it('closes its Redis connection when the client disconnects mid-stream', async () => {
    const { jobId } = await enqueueCrawl();
    await publish(SEED.tenantId, jobId, jobStarted(SEED.tenantId, jobId, 0));

    // No terminal event is published, so the reader is parked in a blocking XREAD when the client
    // walks away — the case that leaks a connection if the disconnect is not handled.
    await readProgress(SEED.applicationId, SEED.leadEmail, `?jobId=${jobId}`, {
      until: (frames) => frames.some((frame) => frame.event === 'job_started'),
    });

    expect(await eventually(() => activeProgressReaders() === 0)).toBe(true);
  });

  it('refuses when the application has no index job to follow', async () => {
    await raw.del(LATEST_JOB_KEY);

    const token = await harness.issuer.sign({ email: SEED.leadEmail });
    const response = await fetch(
      `${baseUrl}/v1/applications/${SEED.applicationId}/index-progress`,
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('validation_failed');
  });

  it('does not stream another tenant’s application', async () => {
    const token = await harness.issuer.sign({ email: SEED.leadEmail });
    const response = await fetch(
      `${baseUrl}/v1/applications/${NEIGHBOUR.applicationId}/index-progress?jobId=${randomUUID()}`,
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('validation_failed');
  });

  it('requires authentication', async () => {
    const response = await fetch(`${baseUrl}/v1/applications/${SEED.applicationId}/index-progress`);
    expect(response.status).toBe(401);
  });
});
