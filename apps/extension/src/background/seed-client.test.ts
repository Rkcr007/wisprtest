import { RuntimeState } from 'protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  createSeedClient,
  SEED_EXECUTE_PATH,
  SEED_PLAN_PATH,
  SEED_REVERT_PATH,
} from './seed-client.js';

/**
 * The seed transport: what it sends, and how it classifies what comes back.
 *
 * The classification is the load-bearing part. `forbidden` has to be distinguishable from the rest
 * because it is the one failure a tester can do nothing about — seeding is off for this application
 * by policy — and a card that offers "try again" for it would be lying about the situation.
 */

const TOKEN = 'scoped-token';
const GATEWAY = 'https://gateway.example.test';

const UUID_SESSION = '33333333-3333-4333-8333-333333333333';
const UUID_APP = '44444444-4444-4444-8444-444444444444';
const UUID_PLAN = '11111111-1111-4111-8111-111111111111';
const UUID_LEDGER = '66666666-6666-4666-8666-666666666666';

const RUNTIME_STATE: RuntimeState = RuntimeState.parse({
  route: '/orders',
  routePattern: '/orders',
  modalStack: [],
  focusedLandmark: null,
  visibleElementKeys: ['orders.list.row'],
  structuralHash: 'a'.repeat(64),
  stateFingerprint: 'b'.repeat(64),
  capturedAt: '2026-08-04T12:00:00.000Z',
});

/**
 * One recorded fetch, read without asserting a tuple shape onto vitest's `calls`.
 *
 * `mock.calls[0]` is typed from the mock's own signature, and casting it to a tuple is the kind of
 * assertion that stops being true the moment the signature changes. Reading it positionally and
 * failing loudly when there is no call keeps the test honest about what it is inspecting.
 */
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

describe('the plan call', () => {
  it('posts to the plan route with the bearer token, and never carries a plan', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ nonsense: true })));
    const client = createSeedClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    await client.plan({
      sessionId: UUID_SESSION,
      applicationId: UUID_APP,
      utterance: 'I need a pending order',
      runtimeState: RUNTIME_STATE,
      bearerToken: TOKEN,
    });

    const { url, init } = callOf(fetchImpl);
    expect(url).toBe(`${GATEWAY}${SEED_PLAN_PATH}`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.sessionId).toBe(UUID_SESSION);
    expect(body.applicationId).toBe(UUID_APP);
    expect(body.utterance).toBe('I need a pending order');
    // Empty is the supported answer until Phase 16's read-back, not an omission.
    expect(body.existingRecords).toEqual([]);
    // Entropy: asking twice for an overdue invoice should give two different invoices.
    expect(body.seed).toBeNull();
    // The memory version is the gateway's to read from the session, and is deliberately absent.
    expect(body).not.toHaveProperty('memoryVersionId');
  });

  it('rejects a malformed response rather than letting it reach a preview card', async () => {
    const client = createSeedClient({
      gatewayOrigin: GATEWAY,
      fetch: () => Promise.resolve(jsonResponse({ planId: 'not-a-uuid' })),
    });

    const outcome = await client.plan({
      sessionId: UUID_SESSION,
      applicationId: UUID_APP,
      utterance: 'I need a pending order',
      runtimeState: RUNTIME_STATE,
      bearerToken: TOKEN,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain('malformed');
  });
});

describe('failure classification', () => {
  it.each([
    ['seeding_forbidden on a 403', 403, 'seeding_forbidden', 'forbidden'],
    ['a policy refusal sent as 400', 400, 'seeding_forbidden', 'forbidden'],
    ['a validation failure', 400, 'validation_failed', 'invalid'],
    ['an unprocessable body', 422, null, 'invalid'],
    ['a gateway fault', 503, null, 'unavailable'],
    ['a rate limit', 429, null, 'unavailable'],
    ['an unauthenticated call', 401, null, 'failed'],
  ])('reads %s as %s', async (_label, status, code, expected) => {
    const client = createSeedClient({
      gatewayOrigin: GATEWAY,
      fetch: () =>
        Promise.resolve(
          jsonResponse(code === null ? { message: 'no' } : { code, message: 'no' }, status),
        ),
    });

    const outcome = await client.execute({
      sessionId: UUID_SESSION,
      planId: UUID_PLAN,
      approvedAt: '2026-08-04T12:00:00.000Z',
      bearerToken: TOKEN,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe(expected);
  });

  it('carries the gateway’s own message through, so the card can be specific', async () => {
    const client = createSeedClient({
      gatewayOrigin: GATEWAY,
      fetch: () =>
        Promise.resolve(
          jsonResponse(
            {
              code: 'seeding_forbidden',
              message: 'seeding is not enabled for this production application',
            },
            403,
          ),
        ),
    });

    const outcome = await client.execute({
      sessionId: UUID_SESSION,
      planId: UUID_PLAN,
      approvedAt: '2026-08-04T12:00:00.000Z',
      bearerToken: TOKEN,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toBe('seeding is not enabled for this production application');
    }
  });

  it('reads a dead connection as unavailable rather than throwing', async () => {
    const client = createSeedClient({
      gatewayOrigin: GATEWAY,
      fetch: () => Promise.reject(new Error('failed to fetch')),
    });

    const outcome = await client.plan({
      sessionId: UUID_SESSION,
      applicationId: UUID_APP,
      utterance: 'I need a pending order',
      runtimeState: RUNTIME_STATE,
      bearerToken: TOKEN,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('unavailable');
  });

  it('gives up on a plan that never answers, and says so as a timeout', async () => {
    const client = createSeedClient({
      gatewayOrigin: GATEWAY,
      planTimeoutMs: 10,
      // Never settles on its own; the abort signal is what ends it.
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        })) as never,
    });

    const outcome = await client.plan({
      sessionId: UUID_SESSION,
      applicationId: UUID_APP,
      utterance: 'I need a pending order',
      runtimeState: RUNTIME_STATE,
      bearerToken: TOKEN,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('timeout');
  });
});

describe('execute and revert', () => {
  it('sends the plan id and the approval instant, and nothing that describes a record', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({})));
    const client = createSeedClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    await client.execute({
      sessionId: UUID_SESSION,
      planId: UUID_PLAN,
      approvedAt: '2026-08-04T12:00:00.000Z',
      bearerToken: TOKEN,
    });

    const { url, init } = callOf(fetchImpl);
    expect(url).toBe(`${GATEWAY}${SEED_EXECUTE_PATH}`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // The whole property: a client cannot describe a record, so it cannot approve one nobody saw.
    expect(Object.keys(body).sort()).toEqual(['approvedAt', 'planId', 'sessionId']);
  });

  it('names one entry for an entry-scoped revert', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({})));
    const client = createSeedClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    await client.revert({
      scope: { kind: 'entry', ledgerEntryId: UUID_LEDGER },
      bearerToken: TOKEN,
    });

    const { url, init } = callOf(fetchImpl);
    expect(url).toBe(`${GATEWAY}${SEED_REVERT_PATH}`);
    expect(JSON.parse(init.body as string)).toEqual({
      scope: 'entry',
      ledgerEntryId: UUID_LEDGER,
    });
  });

  it('names the session for a session-scoped revert', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({})));
    const client = createSeedClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    await client.revert({
      scope: { kind: 'session', sessionId: UUID_SESSION },
      bearerToken: TOKEN,
    });

    const { init } = callOf(fetchImpl);
    expect(JSON.parse(init.body as string)).toEqual({
      scope: 'session',
      sessionId: UUID_SESSION,
    });
  });
});
