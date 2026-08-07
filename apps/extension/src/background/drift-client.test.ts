import type { DriftReport } from 'protocol';
import { describe, expect, it, vi } from 'vitest';

import { createDriftClient, DRIFT_RAISE_PATH, type DriftRaiseInput } from './drift-client.js';

/**
 * The drift transport: what it sends, what it refuses to send twice at once, and how it classifies
 * what comes back.
 *
 * Nothing here may throw. A raise is a notification that must never reach the tester as a failure,
 * so every path — a dead gateway, a timeout, a malformed body — resolves to an outcome.
 */

const TOKEN = 'scoped-token';
const GATEWAY = 'https://gateway.example.test';

const UUID_SESSION = '33333333-3333-4333-8333-333333333333';
const UUID_TENANT = '44444444-4444-4444-8444-444444444444';
const UUID_VERSION = '55555555-5555-4555-8555-555555555555';
const UUID_SCREEN = '66666666-6666-4666-8666-666666666666';
const UUID_REPORT = '77777777-7777-4777-8777-777777777777';

const EXPECTED_HASH = 'a'.repeat(64);
const OBSERVED_HASH = 'b'.repeat(64);

const INPUT: DriftRaiseInput = {
  sessionId: UUID_SESSION,
  screenId: UUID_SCREEN,
  routePattern: '/orders/:id',
  route: '/orders/4903',
  stateFingerprint: 'c'.repeat(64),
  expectedStructuralHash: EXPECTED_HASH,
  observedStructuralHash: OBSERVED_HASH,
  observedAt: '2026-08-07T12:00:00.000Z',
  bearerToken: TOKEN,
};

const REPORT: DriftReport = {
  id: UUID_REPORT,
  tenantId: UUID_TENANT,
  memoryVersionId: UUID_VERSION,
  candidateMemoryVersionId: null,
  screenId: UUID_SCREEN,
  routePattern: '/orders/:id',
  observedRoute: '/orders/4903',
  stateFingerprint: 'c'.repeat(64),
  expectedStructuralHash: EXPECTED_HASH,
  observedStructuralHash: OBSERVED_HASH,
  diff: null,
  status: 'open',
  detectedBy: 'extension',
  aliasMigrationRate: null,
  approvedBy: null,
  createdAt: '2026-08-07T12:00:00.000Z',
  resolvedAt: null,
};

function callOf(
  mock: { mock: { calls: readonly unknown[][] } },
  index = 0,
): { url: string; init: RequestInit } {
  const call = mock.mock.calls[index];
  if (call === undefined) throw new Error(`no fetch was recorded at index ${String(index)}`);
  return { url: call[0] as string, init: call[1] as RequestInit };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createDriftClient', () => {
  it('posts the observation to the raise route with the scoped token', async () => {
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(jsonResponse({ report: REPORT, created: true }, 201)),
    );
    const client = createDriftClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    const outcome = await client.raise(INPUT);

    expect(outcome.ok).toBe(true);
    const { url, init } = callOf(fetchImpl);
    expect(url).toBe(`${GATEWAY}${DRIFT_RAISE_PATH}`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('sends the session id and never a memory version', async () => {
    // The gateway reads the version from the session precisely so a client cannot name one it
    // never loaded. A body that carried one would be inviting that back.
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(jsonResponse({ report: REPORT, created: true }, 201)),
    );
    const client = createDriftClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    await client.raise(INPUT);

    const body: unknown = JSON.parse(callOf(fetchImpl).init.body as string);
    expect(body).toEqual({
      sessionId: UUID_SESSION,
      screenId: UUID_SCREEN,
      routePattern: '/orders/:id',
      route: '/orders/4903',
      stateFingerprint: 'c'.repeat(64),
      expectedStructuralHash: EXPECTED_HASH,
      observedStructuralHash: OBSERVED_HASH,
      observedAt: '2026-08-07T12:00:00.000Z',
    });
  });

  it('reports whether the observation created a report or joined one', async () => {
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(jsonResponse({ report: REPORT, created: false }, 200)),
    );
    const client = createDriftClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    const outcome = await client.raise(INPUT);

    expect(outcome).toEqual({ ok: true, value: { report: REPORT, created: false } });
  });

  it('collapses an identical observation that is still in flight', async () => {
    // Initialised rather than left null: TypeScript does not track an assignment made inside a
    // Promise executor, so a nullable binding narrows to `never` at the call below.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return jsonResponse({ report: REPORT, created: true }, 201);
    });
    const client = createDriftClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    const first = client.raise(INPUT);
    const second = await client.raise(INPUT);

    expect(second).toEqual({ ok: false, reason: 'duplicate', detail: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('sends again once the first raise has settled', async () => {
    // The guard is not a memory of what has been sent — that is the gateway's job, so it survives
    // a worker restart. It forgets the moment the request completes.
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(jsonResponse({ report: REPORT, created: true }, 201)),
    );
    const client = createDriftClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    await client.raise(INPUT);
    await client.raise(INPUT);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not collapse a different hash on the same screen', async () => {
    // Initialised rather than left null: TypeScript does not track an assignment made inside a
    // Promise executor, so a nullable binding narrows to `never` at the call below.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return jsonResponse({ report: REPORT, created: true }, 201);
    });
    const client = createDriftClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    const first = client.raise(INPUT);
    const second = client.raise({ ...INPUT, observedStructuralHash: 'd'.repeat(64) });

    release();
    await Promise.all([first, second]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('classifies a rejected body as invalid', async () => {
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(jsonResponse({ code: 'validation_failed', message: 'bad route' }, 422)),
    );
    const client = createDriftClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    expect(await client.raise(INPUT)).toEqual({
      ok: false,
      reason: 'invalid',
      detail: 'bad route',
    });
  });

  it('classifies a gateway outage as unavailable', async () => {
    const fetchImpl = vi.fn(async () => Promise.resolve(new Response(null, { status: 503 })));
    const client = createDriftClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    expect(await client.raise(INPUT)).toEqual({
      ok: false,
      reason: 'unavailable',
      detail: null,
    });
  });

  it('resolves rather than rejecting when the network is gone', async () => {
    const fetchImpl = vi.fn(async () => Promise.reject(new Error('offline')));
    const client = createDriftClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    expect(await client.raise(INPUT)).toEqual({
      ok: false,
      reason: 'unavailable',
      detail: 'offline',
    });
  });

  it('times out rather than holding a request against a silent gateway', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    const client = createDriftClient({
      gatewayOrigin: GATEWAY,
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      timeoutMs: 5,
    });

    expect(await client.raise(INPUT)).toEqual({ ok: false, reason: 'timeout', detail: null });
  });

  it('rejects a malformed report rather than passing it on', async () => {
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(jsonResponse({ report: { id: 'not-a-uuid' }, created: true }, 201)),
    );
    const client = createDriftClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    expect(await client.raise(INPUT)).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'the gateway sent a malformed drift report',
    });
  });

  it('releases the in-flight guard when the raise fails', async () => {
    const fetchImpl = vi.fn(async () => Promise.reject(new Error('offline')));
    const client = createDriftClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    await client.raise(INPUT);
    await client.raise(INPUT);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
