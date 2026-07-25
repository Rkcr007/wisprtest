import { errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';

import type { GatewayConfig } from '../config.js';
import { UnauthorizedError } from '../errors.js';
import type { Jwks } from './jwks.js';

/**
 * Bearer token verification.
 *
 * Everything a token asserts is checked before any of it is believed:
 *
 * - **Signature**, against the issuer's published keys.
 * - **`iss`**, against the configured issuer. A validly signed token from a different provider
 *   is still not ours.
 * - **`aud`**, against the configured audience. A token minted for another service in the same
 *   estate must not be accepted here — this is the check that stops one compromised service
 *   from impersonating a user against all the others.
 * - **`exp` and `nbf`**, with a configured tolerance for clock skew rather than an assumption
 *   that two machines agree to the second.
 * - **`sub`** and **`email`** present, because a principal cannot be resolved without them.
 *
 * The algorithm list is explicit. Left to the token, `alg` is attacker-controlled, and `none`
 * or a symmetric algorithm verified against a public key are the classic ways to forge one.
 */

const PERMITTED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'];

/** What a verified token asserts, before it has been matched to a user in the database. */
export interface VerifiedToken {
  readonly subject: string;
  readonly email: string;
  readonly sessionId: string | null;
  readonly expiresAt: Date;
}

/** Pull the token out of an `Authorization` header, or explain why there is not one. */
export function readBearerToken(header: string | undefined): string {
  if (header === undefined || header === '') {
    throw new UnauthorizedError('no Authorization header');
  }

  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') {
    throw new UnauthorizedError('Authorization header is not a Bearer credential');
  }

  const token = rest.join(' ').trim();
  if (token === '') throw new UnauthorizedError('Bearer credential is empty');

  return token;
}

export async function verifyToken(
  token: string,
  jwks: Jwks,
  config: GatewayConfig,
): Promise<VerifiedToken> {
  let payload: JWTPayload;

  try {
    ({ payload } = await jwtVerify(token, jwks.getKey, {
      issuer: config.OIDC_ISSUER_URL,
      audience: config.OIDC_AUDIENCE,
      algorithms: PERMITTED_ALGORITHMS,
      clockTolerance: config.OIDC_CLOCK_TOLERANCE_SECONDS,
    }));
  } catch (cause: unknown) {
    throw new UnauthorizedError(describeFailure(cause), { cause });
  }

  const subject = payload.sub;
  if (typeof subject !== 'string' || subject === '') {
    throw new UnauthorizedError('token has no subject');
  }

  const email = payload.email;
  if (typeof email !== 'string' || email === '') {
    throw new UnauthorizedError('token has no email claim');
  }

  if (payload.exp === undefined) {
    // `jwtVerify` accepts a token with no `exp`. A credential that never expires is not one we
    // are willing to hold, so it is rejected here rather than silently trusted forever.
    throw new UnauthorizedError('token has no expiry');
  }

  const sessionId = payload.sid;

  return {
    subject,
    email,
    sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
    expiresAt: new Date(payload.exp * 1000),
  };
}

/**
 * A short reason for the log line.
 *
 * Never reaches the response body — `UnauthorizedError` reports only "authentication required",
 * because telling an unauthenticated caller exactly which check failed helps them iterate
 * towards a token that passes.
 */
function describeFailure(cause: unknown): string {
  if (cause instanceof joseErrors.JWTExpired) return 'token expired';
  if (cause instanceof joseErrors.JWTClaimValidationFailed) return `claim rejected: ${cause.claim}`;
  if (cause instanceof joseErrors.JWSSignatureVerificationFailed) return 'signature invalid';
  if (cause instanceof joseErrors.JWKSNoMatchingKey) return 'no matching key in JWKS';
  if (cause instanceof joseErrors.JWKSTimeout) return 'JWKS fetch timed out';
  if (cause instanceof joseErrors.JOSEError) return `token rejected: ${cause.code}`;
  return 'token rejected';
}
