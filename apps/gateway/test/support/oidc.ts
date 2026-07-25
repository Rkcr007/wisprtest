import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyObject } from 'jose';

/**
 * A real OIDC issuer, in process.
 *
 * The compose stack has no identity provider, and the phase requires integration tests that are
 * not mocks. This is the middle path, and it is not a mock in any sense that matters: a real
 * HTTP server, a real key pair, a real JWKS document, real RFC 7519 tokens with real
 * signatures. The gateway's authentication code takes exactly the path it takes in production —
 * discovery, JWKS fetch, cache, rotation-triggered refetch, signature and claim verification.
 * Nothing in `src/auth` is stubbed or injected past.
 *
 * What it does *not* cover is a specific vendor's quirks and the interactive login flow. Those
 * belong to a deployment test, not to a unit of gateway behaviour, and standing up Keycloak in
 * `make db-up` would slow every developer's startup to test somebody else's software.
 *
 * The server counts JWKS requests, which is how the cache and cooldown tests assert on
 * behaviour rather than on timing.
 */
export interface FakeIssuer {
  readonly issuer: string;
  readonly jwksUri: string;
  /** How many times the JWKS document has been fetched. The cache assertions read this. */
  jwksRequestCount: number;
  /** Mint a token signed by the current key. */
  sign(claims: TokenClaims): Promise<string>;
  /** Mint a token signed by a key the issuer does not publish — a forgery. */
  signWithUnpublishedKey(claims: TokenClaims): Promise<string>;
  /** Replace the signing key and publish the new one, as a real rotation would. */
  rotate(): Promise<void>;
  close(): Promise<void>;
}

export interface TokenClaims {
  readonly email: string;
  readonly audience?: string;
  readonly issuer?: string;
  readonly subject?: string;
  readonly sessionId?: string;
  /** Seconds from now. Negative mints an already-expired token. */
  readonly expiresInSeconds?: number;
  /** Omit `exp` entirely — a credential that never expires. */
  readonly withoutExpiry?: boolean;
}

interface KeyPair {
  readonly privateKey: KeyObject;
  readonly publicJwk: JWK;
  readonly kid: string;
}

async function createKeyPair(kid: string): Promise<KeyPair> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return {
    privateKey: privateKey as unknown as KeyObject,
    publicJwk: { ...publicJwk, kid, alg: 'ES256', use: 'sig' },
    kid,
  };
}

export async function startFakeIssuer(): Promise<FakeIssuer> {
  let current = await createKeyPair('key-1');
  // Never published. Signing with it produces a token that is well-formed in every respect
  // except that its key is not one the issuer vouches for — the shape a forgery actually takes.
  const unpublished = await createKeyPair('key-unpublished');
  let rotations = 0;

  const state = { jwksRequestCount: 0 };

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (url.pathname === '/.well-known/openid-configuration') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          issuer: issuerUrl(),
          jwks_uri: `${issuerUrl()}/jwks.json`,
          // Enough of a discovery document to be realistic; the gateway reads only these two.
          authorization_endpoint: `${issuerUrl()}/auth`,
          token_endpoint: `${issuerUrl()}/token`,
        }),
      );
      return;
    }

    if (url.pathname === '/jwks.json') {
      state.jwksRequestCount += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [current.publicJwk] }));
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  function issuerUrl(): string {
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${String(address.port)}`;
  }

  async function mint(claims: TokenClaims, key: KeyPair): Promise<string> {
    let token = new SignJWT({
      email: claims.email,
      ...(claims.sessionId === undefined ? {} : { sid: claims.sessionId }),
    })
      .setProtectedHeader({ alg: 'ES256', kid: key.kid })
      .setIssuer(claims.issuer ?? issuerUrl())
      .setAudience(claims.audience ?? 'wispr-gateway')
      .setSubject(claims.subject ?? claims.email)
      .setIssuedAt();

    if (claims.withoutExpiry !== true) {
      token = token.setExpirationTime(
        Math.floor(Date.now() / 1000) + (claims.expiresInSeconds ?? 300),
      );
    }

    return token.sign(key.privateKey);
  }

  return {
    get issuer() {
      return issuerUrl();
    },
    get jwksUri() {
      return `${issuerUrl()}/jwks.json`;
    },
    get jwksRequestCount() {
      return state.jwksRequestCount;
    },
    set jwksRequestCount(value: number) {
      state.jwksRequestCount = value;
    },
    sign: (claims) => mint(claims, current),
    signWithUnpublishedKey: (claims) => mint(claims, unpublished),
    rotate: async () => {
      rotations += 1;
      current = await createKeyPair(`key-${String(rotations + 1)}`);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
