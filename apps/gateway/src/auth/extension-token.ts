import { decodeJwt, SignJWT, jwtVerify, type JWTPayload } from 'jose';
import {
  ExtensionTokenScope,
  type ExtensionToken,
  type ExtensionTokenScope as Scope,
} from 'protocol';

import type { GatewayConfig } from '../config.js';
import { ForbiddenError, UnauthorizedError } from '../errors.js';
import {
  minimumRoleFor,
  PERMISSIONS_BY_ROLE,
  roleHasPermission,
  type Permission,
  type Role,
} from '../rbac/permissions.js';

/**
 * Scoped tokens the gateway mints for the extension.
 *
 * The extension cannot be an OIDC client (`.env.example` states why). A tester's console
 * session asks this module to mint a short-lived HMAC JWT; later requests present that JWT
 * as `Authorization: Bearer`. The signing key never leaves this process.
 *
 * `iss` is a constant, not the OIDC issuer: that is what lets the pipeline tell the two
 * kinds of bearer apart without trying both signatures on every request.
 */

export const EXTENSION_TOKEN_ISSUER = 'wispr-extension-token';
export const EXTENSION_TOKEN_AUDIENCE = 'wispr-extension';

const SCOPE_FOR_PERMISSION: Partial<Record<Permission, Scope>> = {
  'memory:read': 'memory:read',
  'alias:write': 'alias:write',
  'session:write': 'session:write',
  'resolve:escalate': 'resolve:escalate',
  'seed:plan': 'seed:plan',
  'seed:execute': 'seed:execute',
  'seed:revert': 'seed:execute',
};

export interface ExtensionClaims {
  readonly email: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly applicationId: string | null;
  readonly scopes: readonly Scope[];
  readonly expiresAt: Date;
}

/**
 * The scopes a role may carry on an extension token: the intersection of the RBAC map and
 * the protocol's closed {@link ExtensionTokenScope} set. A lead's console session can
 * register an application; the token minted for their extension cannot.
 */
export function scopesForRole(role: Role): Scope[] {
  const held = new Set<Scope>();
  for (const permission of PERMISSIONS_BY_ROLE[role]) {
    const scope = SCOPE_FOR_PERMISSION[permission];
    if (scope !== undefined) held.add(scope);
  }
  // Raising drift is `session:write` on the route, and `drift:report` on the protocol token.
  if (roleHasPermission(role, 'session:write')) held.add('drift:report');
  return [...held];
}

/** True when the bearer names this issuer. Unverified — the caller still verifies the signature. */
export function isExtensionBearer(token: string): boolean {
  try {
    return decodeJwt(token).iss === EXTENSION_TOKEN_ISSUER;
  } catch {
    return false;
  }
}

/** The origin a content script will send, or null if `value` is not an http(s) URL. */
export function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Mint a contract-valid {@link ExtensionToken}. */
export async function mintExtensionToken(
  claims: {
    readonly email: string;
    readonly userId: string;
    readonly tenantId: string;
    readonly applicationId: string | null;
    readonly scopes: readonly Scope[];
  },
  config: GatewayConfig,
  now: Date = new Date(),
): Promise<ExtensionToken> {
  if (claims.scopes.length === 0) {
    throw new Error('an extension token with no scopes is not a token');
  }

  const expiresAt = new Date(now.getTime() + config.EXTENSION_TOKEN_TTL_SECONDS * 1000);
  const token = await new SignJWT({
    email: claims.email,
    tid: claims.tenantId,
    aid: claims.applicationId,
    scopes: [...claims.scopes],
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(EXTENSION_TOKEN_ISSUER)
    .setAudience(EXTENSION_TOKEN_AUDIENCE)
    .setSubject(claims.userId)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(signingKey(config));

  return {
    token,
    tokenType: 'Bearer',
    expiresAt: expiresAt.toISOString(),
    tenantId: claims.tenantId,
    applicationId: claims.applicationId,
    scopes: [...claims.scopes],
  };
}

export async function verifyExtensionToken(
  token: string,
  config: GatewayConfig,
): Promise<ExtensionClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, signingKey(config), {
      issuer: EXTENSION_TOKEN_ISSUER,
      audience: EXTENSION_TOKEN_AUDIENCE,
      algorithms: ['HS256'],
      clockTolerance: config.OIDC_CLOCK_TOLERANCE_SECONDS,
    }));
  } catch (cause: unknown) {
    throw new UnauthorizedError('extension token rejected', { cause });
  }

  const email = payload.email;
  const userId = payload.sub;
  const tenantId = payload.tid;
  if (typeof email !== 'string' || email === '') {
    throw new UnauthorizedError('extension token has no email');
  }
  if (typeof userId !== 'string' || userId === '') {
    throw new UnauthorizedError('extension token has no subject');
  }
  if (typeof tenantId !== 'string' || tenantId === '') {
    throw new UnauthorizedError('extension token has no tenant');
  }
  if (payload.exp === undefined) {
    throw new UnauthorizedError('extension token has no expiry');
  }

  const aid = payload.aid;
  const applicationId =
    aid === null || aid === undefined ? null : typeof aid === 'string' ? aid : null;
  if (aid !== null && aid !== undefined && applicationId === null) {
    throw new UnauthorizedError('extension token has a malformed application id');
  }

  const scopes = parseScopes(payload.scopes);
  if (scopes.length === 0) {
    throw new UnauthorizedError('extension token has no scopes');
  }

  return {
    email,
    userId,
    tenantId,
    applicationId,
    scopes,
    expiresAt: new Date(payload.exp * 1000),
  };
}

/**
 * An extension token may only call routes whose permission maps to one of its scopes.
 * Console OIDC tokens have no such restriction — they are authorised by role alone.
 */
export function assertExtensionScope(
  scopes: readonly Scope[] | undefined,
  permission: Permission,
): void {
  if (scopes === undefined) return;
  const scope = SCOPE_FOR_PERMISSION[permission];
  if (scope !== undefined && scopes.includes(scope)) return;
  throw new ForbiddenError(permission, minimumRoleFor(permission));
}

/**
 * An extension token minted for one application cannot read another. A token minted for an
 * origin nobody has registered (`applicationId: null`) cannot read any application's memory —
 * that is the honest "not indexed" attach, not a wildcard.
 *
 * Console OIDC tokens pass: `applicationId` is undefined, not null.
 */
export function assertApplicationScope(
  applicationId: string | null | undefined,
  requestedApplicationId: string,
): void {
  if (applicationId === undefined) return;
  if (applicationId === requestedApplicationId) return;
  throw new ForbiddenError('memory:read', 'tester');
}

function parseScopes(value: unknown): Scope[] {
  if (!Array.isArray(value)) return [];
  const scopes: Scope[] = [];
  for (const item of value) {
    const parsed = ExtensionTokenScope.safeParse(item);
    if (parsed.success) scopes.push(parsed.data);
  }
  return scopes;
}

function signingKey(config: GatewayConfig): Uint8Array {
  return new TextEncoder().encode(config.EXTENSION_TOKEN_SIGNING_KEY);
}
