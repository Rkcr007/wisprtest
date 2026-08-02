import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { Session } from '../auth/session';
import { resetConfigCache } from '../config';
import { ConsoleError } from '../errors';
import { callGateway, callGatewayJson } from './client';

/**
 * The console's server-side gateway client.
 *
 * Two things are asserted here. The first is that the access token stays on the server and is
 * attached to every call — the browser talks to the console's own routes precisely so that it
 * never holds a credential that can start a crawl. The second is that every way a gateway call
 * can fail produces a typed `ConsoleError` carrying something true, because the alternative is
 * the failure mode this suite exists to prevent: a screen that renders empty and says nothing.
 */

const session: Session = { accessToken: 'gateway-access-token', expiresAt: Date.now() + 60_000 };

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

beforeEach(() => {
  Object.assign(process.env, env);
  resetConfigCache();
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

describe('callGateway', () => {
  it('attaches the bearer token and never caches', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await callGateway(session, { method: 'GET', path: '/v1/health' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://gateway.internal:8080/v1/health');
    expect((init.headers as Headers).get('authorization')).toBe('Bearer gateway-access-token');
    // A cached crawl response is a crawl that never ran; a cached stream is not a stream.
    expect(init.cache).toBe('no-store');
  });

  it('does not double a trailing slash on the gateway URL', async () => {
    Object.assign(process.env, { GATEWAY_URL: 'http://gateway.internal:8080/' });
    resetConfigCache();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await callGateway(session, { method: 'GET', path: '/v1/health' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://gateway.internal:8080/v1/health');
  });

  it('sends a JSON body with a content type, and omits both when there is none', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await callGateway(session, { method: 'POST', path: '/v1/x', body: { a: 1 } });
    await callGateway(session, { method: 'GET', path: '/v1/x' });

    const [post, get] = fetchMock.mock.calls.map((call) => call[1] as RequestInit);
    expect((post?.headers as Headers).get('content-type')).toBe('application/json');
    expect(post?.body).toBe('{"a":1}');
    expect((get?.headers as Headers).get('content-type')).toBeNull();
    expect(get?.body).toBeUndefined();
  });

  it('forwards Last-Event-ID so a reconnecting stream resumes where it stopped', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await callGateway(session, {
      method: 'GET',
      path: '/v1/applications/x/index-progress',
      accept: 'text/event-stream',
      lastEventId: '1712-0',
    });

    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Headers;
    expect(headers.get('last-event-id')).toBe('1712-0');
    expect(headers.get('accept')).toBe('text/event-stream');
  });

  it('defaults the accept header to JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await callGateway(session, { method: 'GET', path: '/v1/x' });

    expect(((fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Headers).get('accept')).toBe(
      'application/json',
    );
  });

  it('passes an abort signal through, so closing a tab drops the upstream read', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await callGateway(session, { method: 'GET', path: '/v1/x', signal: controller.signal });

    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal);
  });

  it('turns a transport failure into gateway_unreachable rather than letting it escape raw', async () => {
    const cause = new Error('ECONNREFUSED');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));

    const error = await callGateway(session, { method: 'GET', path: '/v1/x' }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ConsoleError);
    expect((error as ConsoleError).code).toBe('gateway_unreachable');
    expect((error as ConsoleError).status).toBe(502);
    expect((error as ConsoleError).cause).toBe(cause);
  });

  it('returns the raw response, body unread, so a stream stays a stream', async () => {
    const response = new Response('data: {}\n\n', { status: 200 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const returned = await callGateway(session, { method: 'GET', path: '/v1/x' });

    expect(returned.bodyUsed).toBe(false);
    expect(returned).toBe(response);
  });
});

describe('callGatewayJson', () => {
  const Job = z.object({ jobId: z.uuid() });
  const JOB_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

  it('parses a successful response with the contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ jobId: JOB_ID, extra: 'ignored' })));

    await expect(
      callGatewayJson(session, { method: 'GET', path: '/v1/x' }, Job),
    ).resolves.toEqual({ jobId: JOB_ID });
  });

  it('maps a 401 to auth_required — the session outlived the token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ code: 'unauthenticated' }, 401)));

    const error = await callGatewayJson(session, { method: 'GET', path: '/v1/x' }, Job).catch(
      (thrown: unknown) => thrown,
    );

    expect((error as ConsoleError).code).toBe('auth_required');
    expect((error as ConsoleError).status).toBe(401);
  });

  it('carries a typed gateway error through verbatim', async () => {
    // So the screen can render the gateway's own sentence rather than "request failed".
    const wispr = {
      code: 'validation_failed',
      message: 'the crawl bounds do not allow the application’s own origin',
      retryable: false,
      issues: [{ path: 'bounds.allowedOrigins', message: 'must include https://app.example.com' }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(wispr, 400)));

    const error = (await callGatewayJson(session, { method: 'POST', path: '/v1/x' }, Job).catch(
      (thrown: unknown) => thrown,
    )) as ConsoleError;

    expect(error.code).toBe('gateway_rejected');
    expect(error.message).toBe('the crawl bounds do not allow the application’s own origin');
    expect(error.status).toBe(400);
    expect(error.wispr).toMatchObject({ code: 'validation_failed' });
  });

  it('does not read a load balancer’s HTML page as a message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html><h1>504 Gateway Timeout</h1></html>', { status: 504 })),
    );

    const error = (await callGatewayJson(session, { method: 'GET', path: '/v1/x' }, Job).catch(
      (thrown: unknown) => thrown,
    )) as ConsoleError;

    expect(error.code).toBe('gateway_unreachable');
    expect(error.message).toContain('504');
    expect(error.message).not.toContain('<html>');
    expect(error.status).toBe(502);
  });

  it('reports a contract mismatch instead of returning a half-parsed object', async () => {
    // The two sides are typed from the same package, so this means they are deployed against
    // different versions of it. Named, rather than rendered as an empty screen.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ jobId: 'not-a-uuid' })));

    const error = (await callGatewayJson(session, { method: 'GET', path: '/v1/x' }, Job).catch(
      (thrown: unknown) => thrown,
    )) as ConsoleError;

    expect(error.code).toBe('gateway_unreachable');
    expect(error.message).toContain('unexpected shape');
  });

  it('reports a 200 with an unparseable body rather than resolving to null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 200 })));

    await expect(callGatewayJson(session, { method: 'GET', path: '/v1/x' }, Job)).rejects.toBeInstanceOf(
      ConsoleError,
    );
  });

  it('never resolves silently on failure — every path throws', async () => {
    for (const status of [400, 401, 403, 404, 409, 500, 502, 503]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ oops: status }, status)));

      await expect(
        callGatewayJson(session, { method: 'GET', path: '/v1/x' }, Job),
      ).rejects.toBeInstanceOf(ConsoleError);
    }
  });
});
