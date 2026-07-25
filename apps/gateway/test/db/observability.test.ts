import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SEED, startHarness, type Harness } from '../support/harness.js';

/**
 * Logging and correlation, observed on a real request.
 *
 * ARCHITECTURE § 7 requires `tenant_id`, `session_id` and `trace_id` on every line, and CLAUDE.md
 * § "Conventions" forbids element text from ever reaching a log sink. Both are asserted here
 * against lines the server actually emitted, not against the serialiser in isolation — a
 * redaction rule that works in a unit test and is bypassed by the real logger protects nothing.
 */

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness({
    routes: (app) => {
      app.get('/test/logged', (request) => {
        request.log.info(
          {
            event: 'test.line',
            // Everything below is content from the application under test. None of it may
            // survive into the sink.
            accessibleName: 'Approve order for Priya Sharma',
            utterance: 'approve the order for priya',
            label: 'priya.sharma@acme.com',
            payload: { amount: 46_200, customer: 'Acme Industrial' },
            // Ordinary structural fields, which must survive.
            elementKey: 'orders.detail.approve',
            tier: 'T0',
          },
          'handler line',
        );
        return { ok: true };
      });
      app.get('/test/boom', () => {
        throw new Error('deliberate failure');
      });
    },
  });
});

afterAll(async () => {
  await harness.close();
});

async function callAuthenticated(path: string, sessionId?: string) {
  const token = await harness.issuer.sign({
    email: SEED.leadEmail,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  return harness.app.inject({
    method: 'GET',
    url: path,
    headers: { authorization: `Bearer ${token}` },
  });
}

function linesFor(event: string): Record<string, unknown>[] {
  return harness.lines().filter((line) => line.event === event);
}

describe('correlation fields', () => {
  it('stamps tenant, trace and request id on a line emitted inside a handler', async () => {
    await callAuthenticated('/test/logged');
    const line = linesFor('test.line').at(-1);

    expect(line).toBeDefined();
    // The handler passed none of these. They come from the ambient context, which is the whole
    // point — a line emitted deep inside a repository carries them too, with nothing threaded
    // through in between.
    expect(line?.tenant_id).toBe(SEED.tenantId);
    expect(line?.trace_id).toEqual(expect.any(String));
    expect(line?.request_id).toEqual(expect.any(String));
    expect(line?.user_id).toEqual(expect.any(String));
  });

  it('carries the session id when the token has one', async () => {
    await callAuthenticated('/test/logged', 'session-42');
    expect(linesFor('test.line').at(-1)?.session_id).toBe('session-42');
  });

  it('emits one request line per request, with the route pattern and status', async () => {
    const before = linesFor('http.request').length;
    await callAuthenticated('/test/logged');

    const line = linesFor('http.request').at(-1);
    expect(linesFor('http.request').length).toBe(before + 1);
    expect(line).toMatchObject({ route: '/test/logged', status: 200, method: 'GET' });
    expect(line?.duration_ms).toEqual(expect.any(Number));
  });

  it('shares one trace id between the handler line and the request line', async () => {
    await callAuthenticated('/test/logged');

    const handlerLine = linesFor('test.line').at(-1);
    const requestLine = linesFor('http.request').at(-1);
    expect(handlerLine?.trace_id).toBe(requestLine?.trace_id);
  });

  it('returns the request id to the caller so a report can be correlated', async () => {
    const response = await callAuthenticated('/test/logged');
    expect(response.headers['x-request-id']).toBeDefined();
  });
});

describe('redaction', () => {
  it('masks every field that could carry content from the app under test', async () => {
    await callAuthenticated('/test/logged');
    const line = linesFor('test.line').at(-1);
    const serialised = JSON.stringify(line);

    for (const key of ['accessibleName', 'utterance', 'label', 'payload']) {
      expect(line?.[key], `${key} was not redacted`).toBe('[redacted]');
    }

    // The values themselves, wherever they might have ended up.
    expect(serialised).not.toContain('Priya Sharma');
    expect(serialised).not.toContain('priya.sharma@acme.com');
    expect(serialised).not.toContain('Acme Industrial');
    expect(serialised).not.toContain('46200');
  });

  it('leaves structural fields alone, so a log is still worth reading', async () => {
    // Blunt redaction that masked everything would be safe and useless. Element keys and tiers
    // are structure, not content, and they are what make a line diagnostic.
    await callAuthenticated('/test/logged');
    const line = linesFor('test.line').at(-1);

    expect(line?.elementKey).toBe('orders.detail.approve');
    expect(line?.tier).toBe('T0');
  });

  it('never logs the bearer token', async () => {
    await callAuthenticated('/test/logged');
    const everything = JSON.stringify(harness.lines());

    expect(everything).not.toContain('Bearer ');
    expect(everything.toLowerCase()).not.toContain('eyj');
  });
});

describe('the error handler', () => {
  it('logs a 500 at error level and returns an opaque body', async () => {
    const response = await callAuthenticated('/test/boom');

    expect(response.statusCode).toBe(500);
    const body = response.json<{ code: string; message: string; traceId: string }>();
    expect(body.code).toBe('internal');
    // The response says only that something failed, and how to find out what.
    expect(body.message).not.toContain('deliberate failure');
    expect(body.traceId).toEqual(expect.any(String));

    const line = linesFor('http.error').at(-1);
    expect(line?.level).toBe('error');
    expect(line?.status).toBe(500);
  });

  it('keeps the detail in the log line even though the body withholds it', async () => {
    await callAuthenticated('/test/boom');
    const line = linesFor('http.error').at(-1);

    expect(JSON.stringify(line)).toContain('deliberate failure');
  });

  it('correlates the response body’s trace id with the log line', async () => {
    const response = await callAuthenticated('/test/boom');
    const body = response.json<{ traceId: string }>();
    const line = linesFor('http.error').at(-1);

    // This is the whole value of the opaque body: the tester quotes one id and it is findable.
    expect(line?.trace_id).toBe(body.traceId);
  });

  it('logs a client mistake at warn, not error', async () => {
    // Logging a 401 as an error trains people to ignore the error log, which is where the 500s
    // are.
    await harness.app.inject({ method: 'GET', url: '/test/logged' });
    const line = linesFor('http.error').at(-1);

    expect(line?.status).toBe(401);
    expect(line?.level).toBe('warn');
  });

  it('returns a protocol-shaped 404 to an authenticated caller', async () => {
    const response = await callAuthenticated('/no/such/route');

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'resolution_not_found', retryable: false });
  });

  it('gives an unauthenticated probe 401 for a path that does not exist', async () => {
    // Route enumeration: an unauthenticated caller must not be able to tell a real path from an
    // imaginary one, or the 404s map the API for them.
    const missing = await harness.app.inject({ method: 'GET', url: '/no/such/route' });
    const real = await harness.app.inject({ method: 'GET', url: '/test/logged' });

    expect(missing.statusCode).toBe(401);
    expect(real.statusCode).toBe(401);
    expect(missing.json()).toEqual(real.json());
  });
});
