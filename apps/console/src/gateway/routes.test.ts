import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetConfigCache } from '../config';

/**
 * The two console route handlers the browser actually talks to.
 *
 * These are exercised end to end through the real session cookie and the real gateway client,
 * with only `next/headers` and `fetch` replaced — so the assertions cover the whole path a
 * request takes: cookie decrypt, token attach, upstream call, error mapping. Mocking the client
 * instead would leave the one seam most likely to break untested.
 *
 * The property under test throughout is CLAUDE.md rule #1 applied to failure: a gateway that
 * refuses, or that cannot be reached, must reach the tester as an honest error. An empty screen
 * with a 200 on it is the outcome these tests exist to prevent.
 */

const SESSION_COOKIE = 'wispr_console_session';
const APPLICATION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const JOB_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const cookieStore = { value: null as string | null };

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === SESSION_COOKIE && cookieStore.value !== null
          ? { name, value: cookieStore.value }
          : undefined,
    }),
}));

const env = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  CONSOLE_PORT: '3000',
  GATEWAY_URL: 'http://gateway.internal:8080',
  OIDC_ISSUER_URL: 'https://id.example.com',
  OIDC_AUDIENCE: 'https://api.wisprtest.com',
  OIDC_CLIENT_ID: 'console',
  OIDC_REDIRECT_URI: 'http://localhost:3000/auth/callback',
  CONSOLE_SESSION_SECRET: 'a-console-session-secret-of-at-least-32-chars',
};

const original = { ...process.env };

/** A real, correctly sealed session cookie — no fake token shape. */
async function signIn(): Promise<void> {
  const { sealSession } = await import('../auth/session');
  const { config } = await import('../config');
  cookieStore.value = await sealSession(config(), {
    accessToken: 'gateway-access-token',
    expiresAt: Date.now() + 3_600_000,
  });
}

beforeEach(() => {
  Object.assign(process.env, env);
  resetConfigCache();
  cookieStore.value = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...original };
  resetConfigCache();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const bounds = {
  allowedOrigins: ['https://app.example.com'],
  routeAllowlist: ['/orders'],
  maxDepth: 3,
  maxPages: 50,
  neverInteractSelectors: ['button[data-action="delete"]'],
  maxInteractionsPerRoute: 20,
  interactionObserveMs: 1200,
  settleDelayMs: 400,
  networkIdleTimeoutMs: 5000,
  navigationTimeoutMs: 30_000,
  requestsPerMinute: 60,
  viewport: { width: 1440, height: 900 },
};

const validBody = { bounds, authProfile: { kind: 'none' } };

const accepted = {
  jobId: JOB_ID,
  applicationId: APPLICATION_ID,
  messageId: '1712-0',
  requestedAt: '2026-08-02T10:00:00.000Z',
  progressUrl: `/v1/applications/${APPLICATION_ID}/index-progress`,
};

function crawlRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000/api/applications/${APPLICATION_ID}/crawl`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('POST /api/applications/:id/crawl', () => {
  it('forwards a bounded crawl and answers 202 with the job', async () => {
    await signIn();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(accepted, 202));
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('../../app/api/applications/[id]/crawl/route');

    const response = await POST(crawlRequest(validBody), params(APPLICATION_ID));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ jobId: JOB_ID });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://gateway.internal:8080/v1/applications/${APPLICATION_ID}/crawl`);
    // The credential is attached here and only here; the browser never held it.
    expect((init.headers as Headers).get('authorization')).toBe('Bearer gateway-access-token');
    expect(JSON.parse(init.body as string)).toEqual(validBody);
  });

  it('refuses without a session and never calls the gateway', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('../../app/api/applications/[id]/crawl/route');

    const response = await POST(crawlRequest(validBody), params(APPLICATION_ID));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'auth_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an expired session cookie', async () => {
    const { sealSession } = await import('../auth/session');
    const { config } = await import('../config');
    cookieStore.value = await sealSession(config(), {
      accessToken: 'gateway-access-token',
      expiresAt: Date.now() - 60_000,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('../../app/api/applications/[id]/crawl/route');

    const response = await POST(crawlRequest(validBody), params(APPLICATION_ID));

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a forged session cookie', async () => {
    cookieStore.value = 'a.forged.cookie.value.here';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('../../app/api/applications/[id]/crawl/route');

    const response = await POST(crawlRequest(validBody), params(APPLICATION_ID));

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an application id that is not a UUID before touching the gateway', async () => {
    await signIn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('../../app/api/applications/[id]/crawl/route');

    const response = await POST(crawlRequest(validBody), params('../../etc/passwd'));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['no bounds at all', { authProfile: { kind: 'none' } }],
    ['no page cap', { bounds: { ...bounds, maxPages: undefined }, authProfile: { kind: 'none' } }],
    ['no origin allowlist', { bounds: { ...bounds, allowedOrigins: [] }, authProfile: { kind: 'none' } }],
    ['no never-interact key', { bounds: { ...bounds, neverInteractSelectors: undefined }, authProfile: { kind: 'none' } }],
    ['no auth profile', { bounds }],
    ['nothing', {}],
  ])('refuses a crawl with %s, naming the field, without calling the gateway', async (_label, body) => {
    await signIn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('../../app/api/applications/[id]/crawl/route');

    const response = await POST(crawlRequest(body), params(APPLICATION_ID));
    const payload = (await response.json()) as { code: string; issues: { path: string }[] };

    expect(response.status).toBe(400);
    expect(payload.code).toBe('validation_failed');
    expect(payload.issues.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a body carrying a key the contract does not define', async () => {
    // `StartCrawlRequest` is a strict object: an unknown key means the two sides disagree.
    await signIn();
    vi.stubGlobal('fetch', vi.fn());
    const { POST } = await import('../../app/api/applications/[id]/crawl/route');

    const response = await POST(
      crawlRequest({ ...validBody, startUrl: 'https://evil.example' }),
      params(APPLICATION_ID),
    );

    expect(response.status).toBe(400);
  });

  it('refuses a body that is not JSON', async () => {
    await signIn();
    vi.stubGlobal('fetch', vi.fn());
    const { POST } = await import('../../app/api/applications/[id]/crawl/route');

    const request = new NextRequest(
      `http://localhost:3000/api/applications/${APPLICATION_ID}/crawl`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' },
    );

    expect((await POST(request, params(APPLICATION_ID))).status).toBe(400);
  });

  it('passes the gateway’s own validation_failed through with its issues intact', async () => {
    // The gateway makes one check the console cannot: that the allowlist covers the origin the
    // application is registered at. The form attaches that to its field, so it must survive.
    await signIn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            code: 'validation_failed',
            message: 'the crawl bounds do not allow the application’s own origin',
            retryable: false,
            issues: [{ path: 'bounds.allowedOrigins', message: 'must include the base URL origin' }],
          },
          400,
        ),
      ),
    );
    const { POST } = await import('../../app/api/applications/[id]/crawl/route');

    const response = await POST(crawlRequest(validBody), params(APPLICATION_ID));
    const payload = (await response.json()) as { code: string; message: string; issues: unknown[] };

    expect(response.status).toBe(400);
    expect(payload.code).toBe('validation_failed');
    expect(payload.message).toContain('own origin');
    expect(payload.issues).toEqual([
      { path: 'bounds.allowedOrigins', message: 'must include the base URL origin' },
    ]);
  });

  it('reports an unreachable gateway as a 502, not as an empty success', async () => {
    await signIn();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const { POST } = await import('../../app/api/applications/[id]/crawl/route');

    const response = await POST(crawlRequest(validBody), params(APPLICATION_ID));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: 'gateway_unreachable' });
  });

  it('reports a 202 whose body is not a job, rather than redirecting to nowhere', async () => {
    await signIn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ jobId: 'not-a-uuid' }, 202)));
    const { POST } = await import('../../app/api/applications/[id]/crawl/route');

    const response = await POST(crawlRequest(validBody), params(APPLICATION_ID));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: 'gateway_unreachable' });
  });

  it('translates a gateway 401 into a sign-in-again, not a 502', async () => {
    await signIn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ code: 'unauthorized' }, 401)));
    const { POST } = await import('../../app/api/applications/[id]/crawl/route');

    const response = await POST(crawlRequest(validBody), params(APPLICATION_ID));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'auth_required' });
  });
});

describe('GET /api/applications/:id/index-progress', () => {
  function progressRequest(query = '', headers: Record<string, string> = {}): NextRequest {
    return new NextRequest(
      `http://localhost:3000/api/applications/${APPLICATION_ID}/index-progress${query}`,
      { method: 'GET', headers },
    );
  }

  function sseResponse(): Response {
    return new Response('event: job_started\ndata: {}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  it('streams the gateway’s body through with SSE headers', async () => {
    await signIn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse()));
    const { GET } = await import('../../app/api/applications/[id]/index-progress/route');

    const response = await GET(progressRequest(), params(APPLICATION_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toContain('no-store');
    // An intermediary that buffers a stream has turned it into a slow download.
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    await expect(response.text()).resolves.toContain('event: job_started');
  });

  it('attaches the bearer token and forwards the job filter', async () => {
    await signIn();
    const fetchMock = vi.fn().mockResolvedValue(sseResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('../../app/api/applications/[id]/index-progress/route');

    await GET(progressRequest(`?jobId=${JOB_ID}`), params(APPLICATION_ID));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `http://gateway.internal:8080/v1/applications/${APPLICATION_ID}/index-progress?jobId=${JOB_ID}`,
    );
    expect((init.headers as Headers).get('authorization')).toBe('Bearer gateway-access-token');
    expect((init.headers as Headers).get('accept')).toBe('text/event-stream');
  });

  it('forwards Last-Event-ID so a reconnect resumes rather than replaying', async () => {
    await signIn();
    const fetchMock = vi.fn().mockResolvedValue(sseResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('../../app/api/applications/[id]/index-progress/route');

    await GET(progressRequest('', { 'last-event-id': '1712-4' }), params(APPLICATION_ID));

    expect(((fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Headers).get('last-event-id')).toBe(
      '1712-4',
    );
  });

  it('omits Last-Event-ID on a first connection', async () => {
    await signIn();
    const fetchMock = vi.fn().mockResolvedValue(sseResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('../../app/api/applications/[id]/index-progress/route');

    await GET(progressRequest(), params(APPLICATION_ID));

    expect(((fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Headers).get('last-event-id')).toBeNull();
  });

  it('never puts the token in the query string', async () => {
    await signIn();
    const fetchMock = vi.fn().mockResolvedValue(sseResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('../../app/api/applications/[id]/index-progress/route');

    await GET(progressRequest(`?jobId=${JOB_ID}`), params(APPLICATION_ID));

    // The whole reason this proxy exists: a token in a URL lands in every access log en route.
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain('gateway-access-token');
  });

  it('refuses without a session', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('../../app/api/applications/[id]/index-progress/route');

    const response = await GET(progressRequest(), params(APPLICATION_ID));

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an application id that is not a UUID', async () => {
    await signIn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('../../app/api/applications/[id]/index-progress/route');

    expect((await GET(progressRequest(), params('not-a-uuid'))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a non-200 with the gateway’s own message, so EventSource stops retrying', async () => {
    // An unknown application will not start existing on a retry.
    await signIn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ code: 'validation_failed', message: 'no such application', retryable: false, issues: [{ path: 'id', message: 'unknown' }] }, 404),
      ),
    );
    const { GET } = await import('../../app/api/applications/[id]/index-progress/route');

    const response = await GET(progressRequest(), params(APPLICATION_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ message: 'no such application' });
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('does not render an upstream HTML error page', async () => {
    await signIn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>503</html>', { status: 503 })));
    const { GET } = await import('../../app/api/applications/[id]/index-progress/route');

    const response = await GET(progressRequest(), params(APPLICATION_ID));
    const payload = (await response.json()) as { code: string; message: string };

    expect(response.status).toBe(503);
    expect(payload.code).toBe('internal');
    expect(payload.message).not.toContain('<html>');
  });

  it('reports an unreachable gateway rather than opening an empty stream', async () => {
    await signIn();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const { GET } = await import('../../app/api/applications/[id]/index-progress/route');

    const response = await GET(progressRequest(), params(APPLICATION_ID));

    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).not.toContain('text/event-stream');
    await expect(response.json()).resolves.toMatchObject({ code: 'gateway_unreachable' });
  });
});
