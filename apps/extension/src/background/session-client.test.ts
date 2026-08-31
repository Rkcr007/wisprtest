import { describe, expect, it, vi } from 'vitest';

import { createSessionClient, SessionWriteFailed } from './session-client.js';

/**
 * The session client's transport, and the classification the callers above it depend on.
 *
 * `retryable` is not decoration: the step buffer retries on it, and the false-execution path
 * reads it to decide whether "try again" is honest advice or a lie. A 400 misclassified as
 * retryable would wedge the buffer behind a batch that can never land; a 5xx misclassified as
 * permanent would throw away a tester's history over one bad minute.
 */

const GATEWAY = 'https://gateway.wisprtest.example';
const SESSION_ID = '9c5b94b1-35ad-49bb-b118-8e8fc24abf80';
const TOKEN = 'a.scoped.token';

const REPORT = {
  stepOrdinal: 4,
  reason: 'wrong_element' as const,
  expectedElementId: null,
  note: null,
};

const FILED = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  sessionId: SESSION_ID,
  stepOrdinal: 4,
  reason: 'wrong_element',
  expectedElementId: null,
  note: null,
  status: 'open',
  reportedBy: '11111111-1111-4111-8111-111111111111',
  reportedAt: '2026-08-31T12:00:00.000Z',
  withdrawnBy: null,
  withdrawnAt: null,
  withdrawnReason: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('reportFalseExecution', () => {
  it('posts the report to the session it names, with the scoped token', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(FILED)));
    const client = createSessionClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    const report = await client.reportFalseExecution(SESSION_ID, REPORT, TOKEN);

    expect(report.stepOrdinal).toBe(4);
    expect(report.status).toBe('open');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GATEWAY}/v1/sessions/${SESSION_ID}/false-executions`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual(REPORT);
  });

  it('classifies a 400 as permanent, because the step is not there', async () => {
    // The gateway refuses a report naming a step it has not received. Retrying that request
    // changes nothing — what has to happen is a flush, and the caller reads `retryable` to know
    // it should say so rather than silently try again.
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ code: 'validation_failed', message: 'no step' }, 400)),
    );
    const client = createSessionClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    await expect(client.reportFalseExecution(SESSION_ID, REPORT, TOKEN)).rejects.toMatchObject({
      name: 'SessionWriteFailed',
      retryable: false,
      code: 'validation_failed',
    });
  });

  it.each([500, 429, 401])('classifies %i as worth another attempt', async (status) => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ code: 'internal' }, status)));
    const client = createSessionClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    await expect(client.reportFalseExecution(SESSION_ID, REPORT, TOKEN)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('refuses a report the gateway answered with something unrecognisable', async () => {
    // The one lie this feature cannot tell. Reporting "filed" on a malformed answer would put a
    // number nobody can trust into the gate that decides whether a release ships.
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ id: 'not-a-report' })));
    const client = createSessionClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    await expect(client.reportFalseExecution(SESSION_ID, REPORT, TOKEN)).rejects.toBeInstanceOf(
      SessionWriteFailed,
    );
  });

  it('treats a dead connection as retryable', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('network down')));
    const client = createSessionClient({ gatewayOrigin: GATEWAY, fetch: fetchImpl });

    await expect(client.reportFalseExecution(SESSION_ID, REPORT, TOKEN)).rejects.toMatchObject({
      retryable: true,
    });
  });
});
