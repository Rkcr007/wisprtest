import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConsoleConfig } from '../config';
import { ConsoleError } from '../errors';
import {
  authorizationUrl,
  createPkce,
  discover,
  exchangeCode,
  randomToken,
  resetDiscoveryCache,
  type ProviderMetadata,
} from './oidc';

/**
 * The console as an OIDC relying party.
 *
 * The properties worth asserting are the ones that stop a stolen artefact being useful: that the
 * exchange is PKCE-protected with S256, that the console refuses a provider that disagrees about
 * its own identity, and that a provider failure surfaces as a typed `auth_failed` rather than as
 * a page of provider HTML rendered at a tester.
 */

const ISSUER = 'https://id.example.com';

function testConfig(overrides: Partial<ConsoleConfig> = {}): ConsoleConfig {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    CONSOLE_PORT: 3000,
    GATEWAY_URL: 'http://localhost:8080',
    OIDC_ISSUER_URL: ISSUER,
    OIDC_AUDIENCE: 'https://api.wisprtest.com',
    OIDC_CLIENT_ID: 'console',
    OIDC_REDIRECT_URI: 'http://localhost:3000/auth/callback',
    CONSOLE_SESSION_SECRET: 'a-console-session-secret-of-at-least-32-chars',
    ...overrides,
  };
}

const metadata: ProviderMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  resetDiscoveryCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('discover', () => {
  it('reads the well-known document from the configured issuer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(metadata));
    vi.stubGlobal('fetch', fetchMock);

    const found = await discover(testConfig());

    expect(found.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(fetchMock).toHaveBeenCalledWith(
      `${ISSUER}/.well-known/openid-configuration`,
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
  });

  it('does not double a trailing slash on the issuer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(metadata));
    vi.stubGlobal('fetch', fetchMock);

    await discover(testConfig({ OIDC_ISSUER_URL: `${ISSUER}/` }));

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${ISSUER}/.well-known/openid-configuration`);
  });

  it('memoises the document within the TTL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(metadata));
    vi.stubGlobal('fetch', fetchMock);
    const config = testConfig();
    const start = 1_000_000;

    await discover(config, start);
    await discover(config, start + 60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after the TTL, so a rotated endpoint is picked up without a redeploy', async () => {
    // A fresh Response per call: a body can only be read once.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(metadata)));
    vi.stubGlobal('fetch', fetchMock);
    const config = testConfig();
    const start = 1_000_000;

    await discover(config, start);
    await discover(config, start + 11 * 60 * 1000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses a provider that disagrees about its own issuer', async () => {
    // Every token from such a provider would be rejected by the gateway's `iss` check instead,
    // one confusing 401 at a time.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ ...metadata, issuer: 'https://other.example' })),
    );

    await expect(discover(testConfig())).rejects.toMatchObject({
      name: 'ConsoleError',
      code: 'auth_failed',
    });
  });

  it('reports an unreachable provider as auth_failed, keeping the cause', async () => {
    const cause = new Error('ECONNREFUSED');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));

    const error = await discover(testConfig()).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ConsoleError);
    expect((error as ConsoleError).code).toBe('auth_failed');
    expect((error as ConsoleError).cause).toBe(cause);
  });

  it('reports a non-200 discovery document with its status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));

    await expect(discover(testConfig())).rejects.toThrow(/503/);
  });

  it('refuses metadata missing the endpoints it needs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ issuer: ISSUER })));

    await expect(discover(testConfig())).rejects.toMatchObject({ code: 'auth_failed' });
  });

  it('does not cache a failed discovery', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockResolvedValue(jsonResponse(metadata));
    vi.stubGlobal('fetch', fetchMock);
    const config = testConfig();

    await expect(discover(config)).rejects.toThrow();
    await expect(discover(config)).resolves.toMatchObject({ issuer: ISSUER });
  });
});

describe('PKCE', () => {
  it('derives the challenge as the base64url SHA-256 of the verifier', async () => {
    const { verifier, challenge } = await createPkce();

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const expected = Buffer.from(new Uint8Array(digest))
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');

    expect(challenge).toBe(expected);
  });

  it('never returns the verifier as the challenge', async () => {
    const { verifier, challenge } = await createPkce();

    // `plain` offers no protection over an intercepted authorization code.
    expect(challenge).not.toBe(verifier);
  });

  it('produces a fresh pair per attempt', async () => {
    const [first, second] = await Promise.all([createPkce(), createPkce()]);

    expect(first.verifier).not.toBe(second.verifier);
  });

  it('emits URL-safe tokens with no base64 padding', () => {
    const token = randomToken(32);

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain('=');
  });
});

describe('authorizationUrl', () => {
  const url = new URL(
    authorizationUrl(metadata, testConfig(), {
      state: 'state-value',
      nonce: 'nonce-value',
      challenge: 'challenge-value',
    }),
  );

  it('requests an authorization code with S256', () => {
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('names the audience the gateway verifies', () => {
    expect(url.searchParams.get('audience')).toBe('https://api.wisprtest.com');
    expect(url.searchParams.get('client_id')).toBe('console');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/auth/callback');
  });

  it('carries the CSRF state and the nonce', () => {
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('nonce')).toBe('nonce-value');
  });

  it('never puts the client secret or the verifier in a front-channel URL', () => {
    const front = authorizationUrl(metadata, testConfig({ OIDC_CLIENT_SECRET: 'super-secret' }), {
      state: 's',
      nonce: 'n',
      challenge: 'c',
    });

    expect(front).not.toContain('super-secret');
    expect(front).not.toContain('code_verifier');
  });
});

describe('exchangeCode', () => {
  const success = { access_token: 'gateway-token', token_type: 'Bearer', expires_in: 3600 };

  it('posts the verifier and returns the token with an absolute expiry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(success));
    vi.stubGlobal('fetch', fetchMock);
    const now = 1_700_000_000_000;

    const tokens = await exchangeCode(
      metadata,
      testConfig(),
      { code: 'the-code', verifier: 'the-verifier' },
      now,
    );

    expect(tokens.accessToken).toBe('gateway-token');
    expect(tokens.expiresAt).toBe(now + 3_600_000);

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit).body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe('the-verifier');
    expect(body.get('redirect_uri')).toBe('http://localhost:3000/auth/callback');
  });

  it('sends the client secret in the body, never in an Authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(success));
    vi.stubGlobal('fetch', fetchMock);

    await exchangeCode(metadata, testConfig({ OIDC_CLIENT_SECRET: 'super-secret' }), {
      code: 'c',
      verifier: 'v',
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.body as URLSearchParams).get('client_secret')).toBe('super-secret');
    // A Basic header can end up in a proxy access log on a redirect; a body parameter cannot.
    expect(init.headers).not.toHaveProperty('authorization');
  });

  it('omits the client secret for a public client', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(success));
    vi.stubGlobal('fetch', fetchMock);

    await exchangeCode(metadata, testConfig(), { code: 'c', verifier: 'v' });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.body as URLSearchParams).has('client_secret')).toBe(false);
  });

  it('treats a token with no expires_in as already expired', async () => {
    // The gateway rejects a token with no `exp`; sending one anyway produces a 401 with no story.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ access_token: 'a', token_type: 'Bearer' })),
    );
    const now = 1_700_000_000_000;

    const tokens = await exchangeCode(metadata, testConfig(), { code: 'c', verifier: 'v' }, now);

    expect(tokens.expiresAt).toBe(now);
  });

  it('surfaces the provider’s own error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: 'invalid_grant', error_description: 'code used' }, 400),
        ),
    );

    await expect(
      exchangeCode(metadata, testConfig(), { code: 'c', verifier: 'v' }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it('does not render a provider’s HTML error page as a message', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('<html><h1>502 Bad Gateway</h1></html>', { status: 502 })),
    );

    const error = await exchangeCode(metadata, testConfig(), { code: 'c', verifier: 'v' }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ConsoleError);
    expect((error as ConsoleError).message).toContain('HTTP 502');
    expect((error as ConsoleError).message).not.toContain('<html>');
  });

  it('refuses a token type the gateway cannot use', async () => {
    // The gateway reads `Authorization: Bearer …` and nothing else. A DPoP token would be stored,
    // sent, and rejected on every call with no indication why.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ ...success, token_type: 'DPoP' })),
    );

    await expect(
      exchangeCode(metadata, testConfig(), { code: 'c', verifier: 'v' }),
    ).rejects.toThrow(/DPoP/);
  });

  it('accepts a lowercase bearer, which the RFC permits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ ...success, token_type: 'bearer' })),
    );

    await expect(
      exchangeCode(metadata, testConfig(), { code: 'c', verifier: 'v' }),
    ).resolves.toMatchObject({ accessToken: 'gateway-token' });
  });

  it('refuses a 200 response that is not a token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ nothing: 'useful' })));

    await expect(
      exchangeCode(metadata, testConfig(), { code: 'c', verifier: 'v' }),
    ).rejects.toMatchObject({
      code: 'auth_failed',
    });
  });

  it('reports an unreachable token endpoint as auth_failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));

    await expect(
      exchangeCode(metadata, testConfig(), { code: 'c', verifier: 'v' }),
    ).rejects.toMatchObject({
      code: 'auth_failed',
    });
  });
});
