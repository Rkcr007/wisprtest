import {
  EvidenceUploadTicket,
  Session,
  SessionStepIngestResult,
  SessionTimeline,
  type SessionStep,
} from 'protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { evidenceKey } from '../../src/storage/evidence-store.js';
import { createFakeEvidenceStore, type FakeEvidenceStore } from '../support/fake-evidence.js';
import { NEIGHBOUR, SEED, startHarness, type Harness } from '../support/harness.js';

/**
 * The session routes, against the real stack.
 *
 * Three properties carry this suite, and they are the ones the phase names:
 *
 * - **A closed session is closed.** "Sessions are immutable once closed. Enforce it in the API,
 *   not just the UI." Proven for a late batch, for a second close, and for the race where a close
 *   lands while a flush is in flight.
 * - **Ingest is idempotent.** The extension flushes every 5s and retries what it could not
 *   deliver, so the same batch twice must be one timeline — otherwise every dropped response
 *   duplicates a tester's history.
 * - **Evidence is a reference, never bytes.** A timeline resolves storage keys to expiring URLs,
 *   signs each distinct key once, and never signs across a tenant boundary.
 */

let harness: Harness;
let evidence: FakeEvidenceStore;

const STATE = 'a'.repeat(64);
const HASH = 'b'.repeat(64);

beforeAll(async () => {
  evidence = createFakeEvidenceStore();
  harness = await startHarness({ evidence });
});

afterAll(async () => {
  await harness.close();
});

beforeEach(() => {
  evidence.objects.clear();
  evidence.signed.length = 0;
  evidence.uploads.length = 0;
});

async function authed(email: string) {
  const token = await harness.issuer.sign({ email });
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function open(email: string = SEED.testerEmail, body?: unknown) {
  return harness.app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: await authed(email),
    payload: JSON.stringify(
      body ?? { applicationId: SEED.applicationId, memoryVersionId: SEED.memoryVersionId },
    ),
  });
}

async function openSessionId(): Promise<string> {
  const response = await open();
  expect(response.statusCode).toBe(201);
  return Session.parse(response.json()).id;
}

async function close(sessionId: string, body: unknown = { status: 'closed' }) {
  return harness.app.inject({
    method: 'PATCH',
    url: `/v1/sessions/${sessionId}`,
    headers: await authed(SEED.testerEmail),
    payload: JSON.stringify(body),
  });
}

async function postSteps(sessionId: string, steps: readonly unknown[]) {
  return harness.app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/steps`,
    headers: await authed(SEED.testerEmail),
    payload: JSON.stringify({ steps }),
  });
}

async function timeline(sessionId: string, email: string = SEED.testerEmail) {
  return harness.app.inject({
    method: 'GET',
    url: `/v1/sessions/${sessionId}`,
    headers: await authed(email),
  });
}

/**
 * A contract-valid step. `evidence` defaults to none — most steps capture nothing.
 *
 * The id is fresh on every call, as the extension's is: a buffer rebuilt after a service-worker restart
 * re-mints ids for steps it had already sent, so dedup has to rest on `(session, ordinal)` rather
 * than on the id. Tests that need the *same* step twice reuse the returned object.
 */
function step(
  sessionId: string,
  ordinal: number,
  overrides: Partial<SessionStep> = {},
): SessionStep {
  return {
    id: crypto.randomUUID(),
    sessionId,
    ordinal,
    utterance: 'show me only the pending ones',
    intent: {
      verb: 'filter',
      targetPhrase: 'pending',
      constraints: [],
      stateFingerprint: STATE,
      candidateElementKeys: ['orders.filter.pending'],
    },
    resolution: {
      outcome: 'resolved',
      elementId: '55555555-5555-4555-8555-555555555551',
      elementKey: 'orders.filter.pending',
      confidence: 0.97,
      tier: 'T0',
      latencyMs: 8,
      candidates: [],
    },
    elementId: null,
    tier: 'T0',
    confidence: 0.97,
    actionClass: 'R',
    latencyMs: 312,
    outcome: 'executed',
    evidence: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('opening', () => {
  it('opens a session against the tester and their tenant, not the request body', async () => {
    const response = await open();

    expect(response.statusCode).toBe(201);
    const session = Session.parse(response.json());
    expect(session.tenantId).toBe(SEED.tenantId);
    expect(session.applicationId).toBe(SEED.applicationId);
    expect(session.memoryVersionId).toBe(SEED.memoryVersionId);
    // Open, and stamped by the server.
    expect(session.endedAt).toBeNull();
    expect(Date.parse(session.startedAt)).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('refuses a memory version belonging to another tenant', async () => {
    const response = await open(SEED.testerEmail, {
      applicationId: NEIGHBOUR.applicationId,
      memoryVersionId: '77777777-7777-4777-8777-777777777777',
    });

    // RLS makes the neighbour's rows invisible, so this reads as unknown rather than forbidden —
    // the caller cannot tell whether it exists, which is the honest answer.
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('validation_failed');
  });

  it('requires authentication', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        applicationId: SEED.applicationId,
        memoryVersionId: SEED.memoryVersionId,
      }),
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('step ingest', () => {
  it('appends a batch and reports what was new', async () => {
    const sessionId = await openSessionId();

    const response = await postSteps(sessionId, [step(sessionId, 0), step(sessionId, 1)]);

    expect(response.statusCode).toBe(200);
    expect(SessionStepIngestResult.parse(response.json())).toEqual({
      accepted: 2,
      inserted: 2,
      duplicates: 0,
    });
  });

  it('is idempotent on (session, ordinal), so a retried flush is not a second timeline', async () => {
    const sessionId = await openSessionId();
    const batch = [step(sessionId, 0), step(sessionId, 1)];

    await postSteps(sessionId, batch);
    const again = await postSteps(sessionId, batch);

    // The extension retries what it could not confirm. An entirely-duplicate flush is the normal
    // outcome of a dropped response, not an error.
    expect(SessionStepIngestResult.parse(again.json())).toEqual({
      accepted: 2,
      inserted: 0,
      duplicates: 2,
    });

    const steps = SessionTimeline.parse((await timeline(sessionId)).json()).steps;
    expect(steps).toHaveLength(2);
  });

  it('accepts a partially-overlapping batch, inserting only what is new', async () => {
    const sessionId = await openSessionId();
    await postSteps(sessionId, [step(sessionId, 0), step(sessionId, 1)]);

    const overlapping = await postSteps(sessionId, [
      step(sessionId, 1),
      step(sessionId, 2),
      step(sessionId, 3),
    ]);

    expect(SessionStepIngestResult.parse(overlapping.json())).toEqual({
      accepted: 3,
      inserted: 2,
      duplicates: 1,
    });
  });

  it('refuses a batch whose steps name a different session', async () => {
    const sessionId = await openSessionId();
    const other = await openSessionId();

    const response = await postSteps(sessionId, [step(sessionId, 0), step(other, 1)]);

    // A buffer that survived a worker restart could hold an earlier session's steps. One session's
    // history must not spill into another's.
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('validation_failed');

    const steps = SessionTimeline.parse((await timeline(sessionId)).json()).steps;
    expect(steps, 'nothing from a rejected batch is written').toHaveLength(0);
  });

  it('rejects an empty batch', async () => {
    const sessionId = await openSessionId();
    const response = await postSteps(sessionId, []);
    expect(response.statusCode).toBe(400);
  });

  it('rejects steps for an unknown session', async () => {
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    const response = await postSteps(unknown, [step(unknown, 0)]);
    expect(response.statusCode).toBe(400);
  });
});

describe('immutability once closed', () => {
  it('closes a session and stamps the end from the server clock', async () => {
    const sessionId = await openSessionId();

    const response = await close(sessionId);

    expect(response.statusCode).toBe(200);
    const session = Session.parse(response.json());
    expect(session.endedAt).not.toBeNull();
  });

  it('refuses steps after the session is closed', async () => {
    const sessionId = await openSessionId();
    await postSteps(sessionId, [step(sessionId, 0)]);
    await close(sessionId);

    const late = await postSteps(sessionId, [step(sessionId, 1)]);

    // The property the phase asks for, enforced in the API. A late flush is told what it lost and
    // which session ended, rather than appending after the end of a timeline.
    expect(late.statusCode).toBe(409);
    const body = late.json<{ code: string; retryable: boolean; sessionId: string }>();
    expect(body.code).toBe('session_closed');
    expect(body.retryable).toBe(false);
    expect(body.sessionId).toBe(sessionId);

    const steps = SessionTimeline.parse((await timeline(sessionId)).json()).steps;
    expect(steps, 'the timeline is final').toHaveLength(1);
  });

  it('refuses a second close rather than moving the end of a timeline', async () => {
    const sessionId = await openSessionId();
    const first = await close(sessionId);
    const second = await close(sessionId);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.json<{ code: string }>().code).toBe('session_closed');
    // The recorded end is the first one, not the second caller's.
    const after = Session.parse((await timeline(sessionId)).json<{ session: unknown }>().session);
    expect(after.endedAt).toBe(Session.parse(first.json()).endedAt);
  });

  it('does not close a session on an empty or malformed PATCH', async () => {
    const sessionId = await openSessionId();

    expect((await close(sessionId, {})).statusCode).toBe(400);
    expect((await close(sessionId, { status: 'open' })).statusCode).toBe(400);

    // Still open, and still accepting steps.
    expect((await postSteps(sessionId, [step(sessionId, 0)])).statusCode).toBe(200);
  });

  it('loses the race to a concurrent close rather than landing after it', async () => {
    const sessionId = await openSessionId();

    const [closed, ingest] = await Promise.all([
      close(sessionId),
      postSteps(sessionId, [step(sessionId, 0)]),
    ]);

    expect(closed.statusCode).toBe(200);
    // Whichever order they interleaved in, the outcome is consistent: the step is either recorded
    // before the end or refused — never written to a session that has already ended.
    const steps = SessionTimeline.parse((await timeline(sessionId)).json()).steps;
    if (ingest.statusCode === 200) {
      expect(steps).toHaveLength(1);
    } else {
      expect(ingest.statusCode).toBe(409);
      expect(steps).toHaveLength(0);
    }
  });
});

describe('evidence upload tickets', () => {
  async function ticket(sessionId: string, body: unknown) {
    return harness.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/evidence`,
      headers: await authed(SEED.testerEmail),
      payload: JSON.stringify(body),
    });
  }

  const request = {
    kind: 'screenshot',
    stepOrdinal: 3,
    contentHash: HASH,
    contentType: 'image/png',
  };

  it('hands back a key the gateway derived and a URL that expires', async () => {
    const sessionId = await openSessionId();

    const response = await ticket(sessionId, request);

    expect(response.statusCode).toBe(200);
    const parsed = EvidenceUploadTicket.parse(response.json());
    // Derived here, never accepted from the caller: a client-chosen key is a client-chosen path,
    // and the tenant prefix is what keeps one tenant's evidence out of another's.
    expect(parsed.storageKey.startsWith(`tenants/${SEED.tenantId}/sessions/${sessionId}/`)).toBe(
      true,
    );
    expect(parsed.storageKey).toContain('screenshot');
    expect(Date.parse(parsed.expiresAt)).toBeGreaterThan(Date.now());
    expect(evidence.uploads).toEqual([parsed.storageKey]);
  });

  it('gives the same key for the same bytes, so a retried capture is one object', async () => {
    const sessionId = await openSessionId();

    const first = EvidenceUploadTicket.parse((await ticket(sessionId, request)).json());
    const second = EvidenceUploadTicket.parse((await ticket(sessionId, request)).json());

    expect(second.storageKey).toBe(first.storageKey);
  });

  it('refuses a ticket for a closed session', async () => {
    const sessionId = await openSessionId();
    await close(sessionId);

    const response = await ticket(sessionId, request);

    // Evidence for a closed session is an object nothing can reference — paid for, stored, and
    // unreachable from any timeline.
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('session_closed');
    expect(evidence.uploads).toEqual([]);
  });

  it('never accepts the bytes themselves', async () => {
    const sessionId = await openSessionId();

    const response = await ticket(sessionId, { ...request, body: 'iVBORw0KGgo=' });

    // A screenshot has no business transiting the gateway's request pipeline.
    expect(response.statusCode).toBe(400);
  });

  it('rejects a hash that could not key or verify an object', async () => {
    const sessionId = await openSessionId();
    expect((await ticket(sessionId, { ...request, contentHash: 'abc' })).statusCode).toBe(400);
  });

  it('is invisible to another tenant', async () => {
    const sessionId = await openSessionId();
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/evidence`,
      headers: await authed(NEIGHBOUR.ownerEmail),
      payload: JSON.stringify(request),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('the timeline', () => {
  const key = (sessionId: string, ordinal: number) =>
    evidenceKey({
      tenantId: SEED.tenantId,
      sessionId,
      stepOrdinal: ordinal,
      kind: 'screenshot',
      contentHash: HASH,
    });

  it('returns the steps in order with signed URLs for their evidence', async () => {
    const sessionId = await openSessionId();
    const storageKey = key(sessionId, 0);

    await postSteps(sessionId, [
      step(sessionId, 0, {
        outcome: 'failed',
        evidence: [
          {
            kind: 'screenshot',
            storageKey,
            contentHash: HASH,
            capturedAt: new Date().toISOString(),
          },
        ],
      }),
      step(sessionId, 1),
    ]);

    const response = await timeline(sessionId);

    expect(response.statusCode).toBe(200);
    // A tenant's evidence must never sit in a shared cache.
    expect(response.headers['cache-control']).toBe('private, no-store');

    const parsed = SessionTimeline.parse(response.json());
    expect(parsed.steps.map((s) => s.ordinal)).toEqual([0, 1]);
    // The step keeps its storage key and content hash verbatim, so the hash still verifies against
    // whatever the URL serves.
    expect(parsed.steps[0]?.evidence[0]?.storageKey).toBe(storageKey);
    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.evidence[0]?.storageKey).toBe(storageKey);
    expect(Date.parse(parsed.evidence[0]?.expiresAt ?? '')).toBeGreaterThan(Date.now());
  });

  it('signs each distinct key once, however many steps cite it', async () => {
    const sessionId = await openSessionId();
    const shared = key(sessionId, 0);
    const capturedAt = new Date().toISOString();
    const ref = { kind: 'screenshot' as const, storageKey: shared, contentHash: HASH, capturedAt };

    await postSteps(sessionId, [
      step(sessionId, 0, { evidence: [ref] }),
      step(sessionId, 1, { evidence: [ref] }),
    ]);

    const parsed = SessionTimeline.parse((await timeline(sessionId)).json());

    expect(parsed.evidence).toHaveLength(1);
    expect(evidence.signed, 'one object, one link').toEqual([shared]);
  });

  it('never signs a key outside the tenant, whatever a row claims', async () => {
    const sessionId = await openSessionId();
    const foreign = evidenceKey({
      tenantId: NEIGHBOUR.tenantId,
      sessionId,
      stepOrdinal: 0,
      kind: 'dom_snapshot',
      contentHash: HASH,
    });

    await postSteps(sessionId, [
      step(sessionId, 0, {
        evidence: [
          {
            kind: 'dom_snapshot',
            storageKey: foreign,
            contentHash: HASH,
            capturedAt: new Date().toISOString(),
          },
        ],
      }),
    ]);

    const parsed = SessionTimeline.parse((await timeline(sessionId)).json());

    // Defence in depth behind RLS: a key that does not sit under this tenant's prefix is not
    // signed, so no future code path can turn a bad row into a cross-tenant URL.
    expect(parsed.evidence).toEqual([]);
    expect(evidence.signed).toEqual([]);
  });

  it('is invisible to another tenant', async () => {
    const sessionId = await openSessionId();

    const response = await timeline(sessionId, NEIGHBOUR.ownerEmail);

    // Not 403: whether the session exists is itself information.
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('validation_failed');
  });
});
