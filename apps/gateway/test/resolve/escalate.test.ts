import { EscalateResponse } from 'protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ModelError, type ModelRequest } from '../../src/model/index.js';
import { createFakeModel, pick, type FakeReply } from '../support/fake-model.js';
import { SEED, startHarness, type Harness } from '../support/harness.js';

/**
 * The T2 escalation route, against the real stack with a fake model injected.
 *
 * The route itself touches no table — it authenticates, validates, and calls the model — so the
 * candidates here are synthetic rather than seeded: what is under test is the escalation service's
 * behaviour, not a snapshot read. Everything the phase requires is asserted through the fake: that
 * candidate text is redacted before it reaches the model, that a hard budget produces a typed
 * timeout, that an unparseable answer earns one repair retry, that a fast failure falls back, and
 * that a hallucinated id is refused rather than returned.
 */

let harness: Harness;

// A distinct fallback model so the fallback path is exercisable; a short budget so the timeout
// test is fast. Both are injected as config overrides on top of the environment.
const FALLBACK_MODEL = 'claude-fallback-test';
const BUDGET_MS = 150;

const STATE_FP = 'a'.repeat(64);
const PENDING = {
  elementId: '66666666-6666-4666-8666-666666666661',
  elementKey: 'orders.filter.pending',
  label: 'Pending',
};
const APPROVED = {
  elementId: '77777777-7777-4777-8777-777777777771',
  elementKey: 'orders.filter.approved',
  label: 'Approved',
};
// A well-formed id that is not one of the candidates — a hallucination the route must refuse.
const BOGUS_ID = '00000000-0000-4000-8000-0000000000ff';

// The fake reads this per call; each test sets it in `beforeEach`.
let replies: FakeReply[] = [];
const model = createFakeModel((request: ModelRequest, index: number): FakeReply => {
  const reply = replies[index];
  return (
    reply ?? { kind: 'error', error: new ModelError('unavailable', request.model, 'no reply') }
  );
});

beforeAll(async () => {
  harness = await startHarness({
    config: { MODEL_FALLBACK: FALLBACK_MODEL, MODEL_TIMEOUT_MS: BUDGET_MS },
    modelProvider: model.provider,
  });
});

afterAll(async () => {
  await harness.close();
});

beforeEach(() => {
  replies = [];
  model.requests.length = 0;
});

async function escalate(email: string, body: unknown) {
  const token = await harness.issuer.sign({ email });
  return harness.app.inject({
    method: 'POST',
    url: '/v1/resolve/escalate',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    utterance: 'the ones still waiting on someone',
    stateFingerprint: STATE_FP,
    candidates: [PENDING, APPROVED],
    ...overrides,
  };
}

/** The n-th call the model received, or a failure naming the call that never happened. */
function callAt(index: number): ModelRequest {
  const call = model.requests[index];
  if (call === undefined)
    throw new Error(`the model was never called ${String(index + 1)} time(s)`);
  return call;
}

/** The concatenated text of everything the model was shown on a given call. */
function promptText(call: ModelRequest): string {
  return [call.system, ...call.messages.map((message) => message.content)].join('\n');
}

describe('POST /v1/resolve/escalate', () => {
  it('resolves a phrase to the candidate the model picks', async () => {
    replies = [pick(PENDING.elementId, 0.91, 'matches the pending filter')];

    const response = await escalate(SEED.testerEmail, requestBody());

    expect(response.statusCode).toBe(200);
    const result = EscalateResponse.parse(response.json());
    expect(result.elementId).toBe(PENDING.elementId);
    expect(result.confidence).toBeCloseTo(0.91);
    expect(result.reasoning).toContain('pending');
    // One clean answer, one call. No repair, no fallback.
    expect(model.requests).toHaveLength(1);
  });

  it('redacts the utterance and candidate labels before they reach the model', async () => {
    replies = [pick(PENDING.elementId, 0.9, 'ok')];

    const response = await escalate(
      SEED.testerEmail,
      requestBody({
        // A well-behaved extension redacts, but the gateway must not trust that: an un-redacted
        // address arriving here has to be masked before the prompt, or a customer's data reaches a
        // provider. This is the procurement-blocking assertion from CLAUDE.md § "PII rule".
        utterance: 'the order for jane.doe@acme.com',
        candidates: [{ ...PENDING, label: 'Owner j.doe@acme.com' }, APPROVED],
      }),
    );

    expect(response.statusCode).toBe(200);
    const shown = promptText(callAt(0));
    expect(shown).toContain('[email]');
    expect(shown).not.toContain('jane.doe@acme.com');
    expect(shown).not.toContain('j.doe@acme.com');
  });

  it('rejects a request with no candidates', async () => {
    const response = await escalate(SEED.testerEmail, requestBody({ candidates: [] }));

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('validation_failed');
    // A rejected request never reaches the model.
    expect(model.requests).toHaveLength(0);
  });

  it('retries once with a repair instruction when the first answer does not parse', async () => {
    replies = [
      { kind: 'text', text: 'Sure! The answer is the Pending filter.' },
      pick(PENDING.elementId, 0.84, 'the pending filter'),
    ];

    const response = await escalate(SEED.testerEmail, requestBody());

    expect(response.statusCode).toBe(200);
    expect(response.json<{ elementId: string }>().elementId).toBe(PENDING.elementId);
    // Exactly two calls: the answer, then the repair. Never a third on the same model.
    expect(model.requests).toHaveLength(2);
    expect(promptText(callAt(1))).toContain('JSON');
  });

  it('falls back to the second model when the primary keeps returning unusable JSON', async () => {
    replies = [
      { kind: 'text', text: 'not json' },
      { kind: 'text', text: 'still not json' },
      pick(APPROVED.elementId, 0.77, 'the approved filter, from the fallback'),
    ];

    const response = await escalate(SEED.testerEmail, requestBody());

    expect(response.statusCode).toBe(200);
    expect(response.json<{ elementId: string }>().elementId).toBe(APPROVED.elementId);
    // Primary twice (answer + repair), then the fallback model once.
    expect(model.requests).toHaveLength(3);
    expect(callAt(2).model).toBe(FALLBACK_MODEL);
  });

  it('falls back when the primary model fails fast, within the budget', async () => {
    replies = [
      { kind: 'error', error: new ModelError('unavailable', 'primary', 'provider 503') },
      pick(PENDING.elementId, 0.88, 'from the fallback'),
    ];

    const response = await escalate(SEED.testerEmail, requestBody());

    expect(response.statusCode).toBe(200);
    expect(model.requests).toHaveLength(2);
    expect(callAt(1).model).toBe(FALLBACK_MODEL);
  });

  it('returns a typed timeout when the model exceeds the budget, so the extension disambiguates', async () => {
    replies = [{ kind: 'hang' }];

    const response = await escalate(SEED.testerEmail, requestBody());

    expect(response.statusCode).toBe(504);
    const body = response.json<{ code: string; retryable: boolean; tier: string }>();
    expect(body.code).toBe('resolution_timeout');
    expect(body.retryable).toBe(true);
    expect(body.tier).toBe('T2');
    // A timeout spends the budget; there is nothing left for a fallback attempt.
    expect(model.requests).toHaveLength(1);
  });

  it('refuses a candidate id the model invented rather than executing a hallucination', async () => {
    replies = [
      pick(BOGUS_ID, 0.99, 'confidently wrong'),
      pick(BOGUS_ID, 0.99, 'still wrong'),
      pick(BOGUS_ID, 0.99, 'wrong on the fallback too'),
    ];

    const response = await escalate(SEED.testerEmail, requestBody());

    expect(response.statusCode).toBe(404);
    const body = response.json<{ code: string; tier: string }>();
    expect(body.code).toBe('resolution_not_found');
    expect(body.tier).toBe('T2');
    // It exhausted primary (answer + repair) and the fallback before giving up.
    expect(model.requests).toHaveLength(3);
  });

  it('requires authentication', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/resolve/escalate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(requestBody()),
    });
    expect(response.statusCode).toBe(401);
  });
});
