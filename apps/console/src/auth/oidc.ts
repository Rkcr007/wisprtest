import { z } from 'zod';

import type { ConsoleConfig } from '../config';
import { ConsoleError } from '../errors';

/**
 * The console as an OIDC relying party: discovery, PKCE, and the authorization-code exchange.
 *
 * ARCHITECTURE § 8 settles the mechanism — "OIDC for console" — and the gateway settles what a
 * usable token looks like: signed by `OIDC_ISSUER_URL`, audience `OIDC_AUDIENCE`, carrying `sub`
 * and `email` (`apps/gateway/src/auth/verify.ts`). This module obtains one.
 *
 * Two properties matter more than the plumbing:
 *
 * - **The browser never holds the token.** The code lands on a server route, is exchanged
 *   server-side, and the result goes into an encrypted cookie (`session.ts`). A token in
 *   `localStorage` is a token any injected script can read, and this one authorises starting a
 *   crawl against the customer's application.
 * - **PKCE is not optional.** The verifier is generated per attempt, kept in a short-lived
 *   HTTP-only cookie, and never leaves the server except as its SHA-256 challenge. An
 *   intercepted authorization code is then useless on its own (RFC 7636 § 1).
 */

/** The subset of the provider's metadata the console uses. Anything else is ignored, not rejected. */
const ProviderMetadata = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  /** Present on providers that support RP-initiated logout. Absent is normal. */
  end_session_endpoint: z.url().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});
export type ProviderMetadata = z.infer<typeof ProviderMetadata>;

/**
 * A successful token response (RFC 6749 § 5.1).
 *
 * `expires_in` is optional in the specification and the gateway rejects a token with no `exp`
 * anyway, so an absent value is treated as "expires now" by the caller rather than as "never".
 */
const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
  id_token: z.string().min(1).optional(),
});

/** An error response (RFC 6749 § 5.2). Rendered as a cause, never as a page of provider HTML. */
const TokenErrorResponse = z.object({
  error: z.string().min(1),
  error_description: z.string().optional(),
});

export interface TokenSet {
  readonly accessToken: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

/**
 * The discovery document, memoised per process.
 *
 * Providers publish this as effectively static, and re-fetching it on every sign-in adds a round
 * trip to a page the tester is waiting on. Re-fetched after {@link DISCOVERY_TTL_MS} so a key
 * rotation or an endpoint move is picked up without a redeploy.
 */
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

let discovered: { metadata: ProviderMetadata; at: number } | null = null;

export function resetDiscoveryCache(): void {
  discovered = null;
}

export async function discover(config: ConsoleConfig, now: number = Date.now()): Promise<ProviderMetadata> {
  if (discovered !== null && now - discovered.at < DISCOVERY_TTL_MS) return discovered.metadata;

  const url = `${config.OIDC_ISSUER_URL.replace(/\/$/, '')}/.well-known/openid-configuration`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (cause: unknown) {
    throw new ConsoleError('auth_failed', 'the identity provider could not be reached', { cause });
  }

  if (!response.ok) {
    throw new ConsoleError(
      'auth_failed',
      `the identity provider's discovery document returned ${String(response.status)}`,
    );
  }

  const parsed = ProviderMetadata.safeParse(await response.json());
  if (!parsed.success) {
    throw new ConsoleError('auth_failed', 'the identity provider published unusable metadata', {
      cause: parsed.error,
    });
  }

  if (parsed.data.issuer !== config.OIDC_ISSUER_URL.replace(/\/$/, '')) {
    // The document is fetched *from* the configured issuer, so a mismatch means the deployment is
    // pointed at a provider that does not agree about its own identity — and the gateway checks
    // `iss` against the configured value, so every token from it would be rejected there instead,
    // one confusing 401 at a time.
    throw new ConsoleError(
      'auth_failed',
      'the identity provider’s issuer does not match OIDC_ISSUER_URL',
    );
  }

  discovered = { metadata: parsed.data, at: now };
  return parsed.data;
}

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

/** A fresh PKCE pair. S256 only: `plain` offers no protection over an intercepted code. */
export async function createPkce(): Promise<Pkce> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** A URL-safe random token of `bytes` entropy. Used for the verifier, `state` and `nonce`. */
export function randomToken(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export interface AuthorizationRequest {
  readonly state: string;
  readonly nonce: string;
  readonly challenge: string;
}

/**
 * Where to send the browser to sign in.
 *
 * `audience` is included because the gateway verifies `aud`: providers that mint API tokens
 * (Auth0, Okta, Keycloak with an audience mapper) need to be told which API the token is for, and
 * one that does not use the parameter ignores it.
 */
export function authorizationUrl(
  metadata: ProviderMetadata,
  config: ConsoleConfig,
  request: AuthorizationRequest,
): string {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.OIDC_CLIENT_ID);
  url.searchParams.set('redirect_uri', config.OIDC_REDIRECT_URI);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('audience', config.OIDC_AUDIENCE);
  url.searchParams.set('state', request.state);
  url.searchParams.set('nonce', request.nonce);
  url.searchParams.set('code_challenge', request.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * Exchange an authorization code for an access token.
 *
 * The client secret, when the deployment has one, goes in the body rather than in a Basic header:
 * both are permitted by RFC 6749 § 2.3.1, and a body parameter cannot end up in a proxy access
 * log the way an `Authorization` header can when a provider redirects.
 */
export async function exchangeCode(
  metadata: ProviderMetadata,
  config: ConsoleConfig,
  params: { code: string; verifier: string },
  now: number = Date.now(),
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: config.OIDC_REDIRECT_URI,
    client_id: config.OIDC_CLIENT_ID,
    code_verifier: params.verifier,
  });
  if (config.OIDC_CLIENT_SECRET !== undefined) {
    body.set('client_secret', config.OIDC_CLIENT_SECRET);
  }

  let response: Response;
  try {
    response = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
    });
  } catch (cause: unknown) {
    throw new ConsoleError('auth_failed', 'the token endpoint could not be reached', { cause });
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const failure = TokenErrorResponse.safeParse(payload);
    const reason = failure.success ? failure.data.error : `HTTP ${String(response.status)}`;
    throw new ConsoleError('auth_failed', `the identity provider refused the code: ${reason}`);
  }

  const parsed = TokenResponse.safeParse(payload);
  if (!parsed.success) {
    throw new ConsoleError('auth_failed', 'the identity provider returned an unusable token', {
      cause: parsed.error,
    });
  }

  if (parsed.data.token_type.toLowerCase() !== 'bearer') {
    // The gateway reads `Authorization: Bearer …` and nothing else. A DPoP or MAC token would be
    // stored, sent, and rejected on every call with no indication why.
    throw new ConsoleError(
      'auth_failed',
      `the identity provider issued a ${parsed.data.token_type} token; the gateway accepts Bearer`,
    );
  }

  return {
    accessToken: parsed.data.access_token,
    // No `expires_in` means the console cannot know when the token dies, so it treats it as
    // already dead: the next request signs in again, rather than sending a token the gateway will
    // reject for having no `exp`.
    expiresAt: now + (parsed.data.expires_in ?? 0) * 1000,
  };
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
