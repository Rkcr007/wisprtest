import { EncryptJWT, jwtDecrypt } from 'jose';
import { z } from 'zod';

import type { ConsoleConfig } from '../config';

/**
 * The console's two cookies, and the encryption that makes them safe to hand to a browser.
 *
 * Both hold something that must not be readable outside this process — an access token for the
 * gateway, and a PKCE verifier — so both are encrypted (JWE, `dir` + A256GCM) rather than signed.
 * A signed cookie is tamper-evident but plaintext, and "plaintext" here means the tenant's bearer
 * token sitting in a browser jar for any extension or XSS to read.
 *
 * Expiry is carried as the JWT `exp` claim rather than only as the cookie's `Max-Age`, because a
 * cookie's lifetime is enforced by the browser and this one is enforced by the server:
 * `jwtDecrypt` refuses an expired token, so a replayed cookie reads as no session at all.
 */

/** Cookie holding the gateway access token. */
export const SESSION_COOKIE = 'wispr_console_session';

/** Cookie holding one sign-in attempt's PKCE verifier and CSRF state. */
export const FLOW_COOKIE = 'wispr_console_flow';

/** How long a sign-in may take from redirect to callback. */
export const FLOW_TTL_SECONDS = 600;

const SessionClaims = z.object({
  /** The gateway access token. */
  at: z.string().min(1),
  exp: z.number().int().positive(),
});

const FlowClaims = z.object({
  /** PKCE code verifier. Never leaves the server; only its S256 challenge does. */
  v: z.string().min(1),
  /** CSRF state, compared with the `state` the provider returns. */
  s: z.string().min(1),
  /** Nonce sent to the provider. */
  n: z.string().min(1),
  /** Path within the console to return to. Always a same-site absolute path. */
  r: z.string().startsWith('/'),
  exp: z.number().int().positive(),
});

export interface Session {
  readonly accessToken: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

export interface FlowState {
  readonly verifier: string;
  readonly state: string;
  readonly nonce: string;
  readonly returnTo: string;
}

/**
 * The content-encryption key.
 *
 * SHA-256 of the configured secret, so any secret of at least the configured 32 characters
 * produces the exactly 32 bytes A256GCM requires — rather than failing at runtime on a secret
 * that is one character short of a raw key.
 */
async function key(config: ConsoleConfig): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(config.CONSOLE_SESSION_SECRET),
  );
  return new Uint8Array(digest);
}

async function seal(
  config: ConsoleConfig,
  claims: Record<string, string>,
  expiresAtSeconds: number,
): Promise<string> {
  return new EncryptJWT(claims)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(expiresAtSeconds)
    .encrypt(await key(config));
}

async function open(config: ConsoleConfig, token: string): Promise<unknown> {
  const { payload } = await jwtDecrypt(token, await key(config));
  return payload;
}

export async function sealSession(config: ConsoleConfig, session: Session): Promise<string> {
  return seal(config, { at: session.accessToken }, Math.floor(session.expiresAt / 1000));
}

/**
 * The session in a cookie value, or null.
 *
 * Null covers every way a cookie can fail to be a session — absent, expired, encrypted under a
 * rotated secret, or forged — because all of them mean the same thing to a caller: sign in again.
 */
export async function openSession(config: ConsoleConfig, token: string): Promise<Session | null> {
  try {
    const claims = SessionClaims.safeParse(await open(config, token));
    if (!claims.success) return null;
    return { accessToken: claims.data.at, expiresAt: claims.data.exp * 1000 };
  } catch {
    return null;
  }
}

export async function sealFlow(
  config: ConsoleConfig,
  flow: FlowState,
  now: number = Date.now(),
): Promise<string> {
  return seal(
    config,
    { v: flow.verifier, s: flow.state, n: flow.nonce, r: flow.returnTo },
    Math.floor(now / 1000) + FLOW_TTL_SECONDS,
  );
}

export async function openFlow(config: ConsoleConfig, token: string): Promise<FlowState | null> {
  try {
    const claims = FlowClaims.safeParse(await open(config, token));
    if (!claims.success) return null;
    return {
      verifier: claims.data.v,
      state: claims.data.s,
      nonce: claims.data.n,
      returnTo: claims.data.r,
    };
  } catch {
    return null;
  }
}

/**
 * A caller-supplied return path, reduced to something safe to redirect to.
 *
 * Anything that is not a single-slash-prefixed path becomes `/`. `//evil.example` and
 * `/\evil.example` are both read by browsers as protocol-relative URLs, which is the open-redirect
 * this exists to close.
 */
export function safeReturnTo(candidate: string | null): string {
  if (candidate === null) return '/';
  if (!candidate.startsWith('/')) return '/';
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return '/';
  return candidate;
}

/** Cookie attributes shared by both cookies. `secure` is dropped only for local plain HTTP. */
export function cookieOptions(
  config: ConsoleConfig,
  maxAgeSeconds: number,
): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
} {
  return {
    httpOnly: true,
    // `lax` rather than `strict`: the sign-in callback is a top-level navigation *from the
    // identity provider*, and `strict` would withhold the flow cookie on exactly that request.
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}
