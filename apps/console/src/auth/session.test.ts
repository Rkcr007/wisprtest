import { describe, expect, it } from 'vitest';

import type { ConsoleConfig } from '../config';
import {
  cookieOptions,
  FLOW_TTL_SECONDS,
  openFlow,
  openSession,
  safeReturnTo,
  sealFlow,
  sealSession,
} from './session';

/**
 * The two cookies, and the properties that make them safe to hand to a browser.
 *
 * The session cookie holds a live gateway access token. Every assertion here is about one of two
 * things: that the token cannot be read out of the cookie, and that a cookie the console did not
 * mint — forged, tampered with, expired, or sealed under a rotated secret — reads as no session
 * at all rather than as somebody's session.
 */

const SECRET = 'a-console-session-secret-of-at-least-32-chars';

function testConfig(overrides: Partial<ConsoleConfig> = {}): ConsoleConfig {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    CONSOLE_PORT: 3000,
    GATEWAY_URL: 'http://localhost:8080',
    OIDC_ISSUER_URL: 'https://id.example.com',
    OIDC_AUDIENCE: 'https://api.wisprtest.com',
    OIDC_CLIENT_ID: 'console',
    OIDC_REDIRECT_URI: 'http://localhost:3000/auth/callback',
    CONSOLE_SESSION_SECRET: SECRET,
    ...overrides,
  };
}

const config = testConfig();
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.gateway-access-token.signature';

describe('the session cookie', () => {
  it('round-trips a session', async () => {
    const expiresAt = Date.now() + 3_600_000;
    const cookie = await sealSession(config, { accessToken: TOKEN, expiresAt });

    const opened = await openSession(config, cookie);

    expect(opened).not.toBeNull();
    expect(opened?.accessToken).toBe(TOKEN);
    // `exp` is second-granularity, so the round trip is exact only to the second.
    expect(opened?.expiresAt).toBe(Math.floor(expiresAt / 1000) * 1000);
  });

  it('encrypts rather than signs — the token is not readable in the cookie', async () => {
    const cookie = await sealSession(config, {
      accessToken: TOKEN,
      expiresAt: Date.now() + 60_000,
    });

    // A signed-but-plaintext cookie would carry the token base64 in its payload segment, readable
    // by any extension or injected script that can reach the jar.
    expect(cookie).not.toContain(TOKEN);
    expect(cookie).not.toContain('gateway-access-token');
    expect(Buffer.from(cookie, 'base64').toString('utf8')).not.toContain('gateway-access-token');
    // JWE compact serialisation: five dot-separated segments, not the three of a JWS.
    expect(cookie.split('.')).toHaveLength(5);
  });

  it.each([
    ['ciphertext', 3],
    ['authentication tag', 4],
    ['initialisation vector', 2],
  ])('rejects a cookie whose %s has been tampered with', async (_label, segment) => {
    const cookie = await sealSession(config, {
      accessToken: TOKEN,
      expiresAt: Date.now() + 60_000,
    });
    const parts = cookie.split('.');
    const original = parts[segment] ?? '';
    // The leading character, so the flip lands on whole bytes rather than on the padding bits a
    // trailing base64url character can carry — a change there can decode to the same plaintext.
    parts[segment] = `${original.startsWith('A') ? 'B' : 'A'}${original.slice(1)}`;

    expect(await openSession(config, parts.join('.'))).toBeNull();
  });

  it('rejects an expired cookie server-side, not only via Max-Age', async () => {
    // Cookie lifetime is enforced by the browser; a replayed cookie ignores it entirely. `exp` is
    // what makes the replay useless.
    const cookie = await sealSession(config, {
      accessToken: TOKEN,
      expiresAt: Date.now() - 60_000,
    });

    expect(await openSession(config, cookie)).toBeNull();
  });

  it('rejects a cookie sealed under a rotated secret', async () => {
    const cookie = await sealSession(config, {
      accessToken: TOKEN,
      expiresAt: Date.now() + 60_000,
    });
    const rotated = testConfig({
      CONSOLE_SESSION_SECRET: 'a-different-secret-of-at-least-32-chars!!',
    });

    expect(await openSession(rotated, cookie)).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['not a token', 'not-a-token'],
    ['a bare JWS', 'eyJhbGciOiJub25lIn0.eyJhdCI6InN0b2xlbiJ9.'],
    ['five segments of noise', 'a.b.c.d.e'],
  ])('reads %s as no session', async (_label, candidate) => {
    expect(await openSession(config, candidate)).toBeNull();
  });

  it('carries no tenant the browser could choose', async () => {
    // CLAUDE.md rule #7: tenancy is derived, never asserted by the client. The console holds the
    // gateway's bearer token and nothing else, so the tenant is whatever the token's issuer says
    // it is. A tenant id in this cookie would be a tenant id a tampering client could edit.
    const cookie = await sealSession(config, {
      accessToken: TOKEN,
      expiresAt: Date.now() + 60_000,
    });
    const opened = await openSession(config, cookie);

    expect(Object.keys(opened ?? {}).sort()).toEqual(['accessToken', 'expiresAt']);
  });
});

describe('the flow cookie', () => {
  const flow = {
    verifier: 'a-pkce-code-verifier-value',
    state: 'csrf-state-value',
    nonce: 'nonce-value',
    returnTo: '/applications/abc/indexing',
  };

  it('round-trips one sign-in attempt', async () => {
    const opened = await openFlow(config, await sealFlow(config, flow));

    expect(opened).toEqual(flow);
  });

  it('never exposes the PKCE verifier in the cookie value', async () => {
    const cookie = await sealFlow(config, flow);

    // The verifier is the whole protection an intercepted authorization code has (RFC 7636 § 1).
    expect(cookie).not.toContain(flow.verifier);
  });

  it('expires the attempt after the flow TTL', async () => {
    const startedAt = Date.now() - (FLOW_TTL_SECONDS + 60) * 1000;

    expect(await openFlow(config, await sealFlow(config, flow, startedAt))).toBeNull();
  });

  it('is still valid just inside the TTL', async () => {
    const startedAt = Date.now() - (FLOW_TTL_SECONDS - 60) * 1000;

    expect(await openFlow(config, await sealFlow(config, flow, startedAt))).not.toBeNull();
  });

  it('rejects a session cookie presented as a flow cookie', async () => {
    // Both are sealed with the same key, so only the claim schema tells them apart.
    const session = await sealSession(config, {
      accessToken: TOKEN,
      expiresAt: Date.now() + 60_000,
    });

    expect(await openFlow(config, session)).toBeNull();
  });

  it('rejects a flow cookie presented as a session cookie', async () => {
    expect(await openSession(config, await sealFlow(config, flow))).toBeNull();
  });

  it('rejects a flow whose return path is not a path', async () => {
    const cookie = await sealFlow(config, { ...flow, returnTo: 'https://evil.example' });

    expect(await openFlow(config, cookie)).toBeNull();
  });
});

describe('safeReturnTo', () => {
  it('keeps a same-site absolute path', () => {
    expect(safeReturnTo('/applications/abc/indexing?jobId=1')).toBe(
      '/applications/abc/indexing?jobId=1',
    );
  });

  it('defaults to the root when there is no candidate', () => {
    expect(safeReturnTo(null)).toBe('/');
  });

  it.each([
    ['a protocol-relative URL', '//evil.example/phish'],
    ['a backslash-escaped one', '/\\evil.example/phish'],
    ['an absolute URL', 'https://evil.example'],
    ['a scheme-only redirect', 'javascript:alert(1)'],
    ['a relative path', 'applications'],
    ['the empty string', ''],
  ])('refuses %s', (_label, candidate) => {
    expect(safeReturnTo(candidate)).toBe('/');
  });
});

describe('cookieOptions', () => {
  it('is HTTP-only and lax in every environment', () => {
    const options = cookieOptions(config, 600);

    // HTTP-only because the value is a credential; lax because the OIDC callback is a top-level
    // navigation from the provider and `strict` would withhold the cookie on exactly that request.
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
    expect(options.maxAge).toBe(600);
  });

  it('sets secure in production and drops it only for local plain HTTP', () => {
    expect(cookieOptions(testConfig({ NODE_ENV: 'production' }), 600).secure).toBe(true);
    expect(cookieOptions(testConfig({ NODE_ENV: 'development' }), 600).secure).toBe(false);
  });
});
