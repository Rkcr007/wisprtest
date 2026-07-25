import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';

import type { GatewayConfig } from '../config.js';
import { DependencyUnavailableError } from '../errors.js';

/**
 * The identity provider's signing keys, cached, with rotation handled.
 *
 * Two failure modes shape this, and they pull in opposite directions:
 *
 * - **Fetching the JWKS per request** puts the identity provider in the hot path of every
 *   authenticated call. It is slow, and it means an IdP hiccup takes the gateway down with it.
 * - **Caching it forever** means a routine key rotation locks every user out until a redeploy.
 *
 * `createRemoteJWKSet` resolves both: keys are cached for `cacheMaxAge`, and a token whose
 * `kid` is not in the cache triggers a refetch — but no more often than `cooldownDuration`, so
 * a flood of tokens signed by an unknown key cannot be turned into a denial-of-service attack
 * against the IdP. That last property is why it is used rather than a hand-rolled map.
 *
 * ## Discovery is lazy, and that is deliberate
 *
 * `OIDC_JWKS_URI` pins the endpoint. When it is absent the URI is discovered from the issuer's
 * `/.well-known/openid-configuration`, as the specification says to — but on first use, not at
 * boot.
 *
 * Resolving at boot is superficially attractive: a misconfigured issuer becomes a startup
 * failure rather than a 401 an hour later. It is the wrong trade. It makes the gateway unable
 * to start whenever the identity provider is briefly unreachable, which under an orchestrator
 * means a crash loop — and the readiness probe covers postgres, redis and qdrant precisely
 * because those are the dependencies the service cannot serve *anything* without. Health
 * endpoints and readiness must keep working through an IdP outage; only authentication should
 * fail, and it should recover on its own when the provider returns.
 *
 * A failed discovery is not cached. The next request retries, so recovery needs no restart.
 */

export interface Jwks {
  readonly getKey: JWTVerifyGetKey;
  /** The resolved URI, for logging and tests. Resolves discovery if it has not run yet. */
  resolveUri(): Promise<string>;
}

interface DiscoveryDocument {
  readonly jwks_uri?: unknown;
  readonly issuer?: unknown;
}

/** Resolve the JWKS URI, by discovery when it was not pinned. */
export async function resolveJwksUri(config: GatewayConfig): Promise<string> {
  if (config.OIDC_JWKS_URI !== undefined) return config.OIDC_JWKS_URI;

  const discoveryUrl = new URL(
    '.well-known/openid-configuration',
    // The trailing slash matters to `new URL`: without it the last path segment is replaced
    // rather than appended, so an issuer at `https://idp.example/realms/wispr` would be
    // discovered at `https://idp.example/realms/.well-known/...`.
    config.OIDC_ISSUER_URL.endsWith('/') ? config.OIDC_ISSUER_URL : `${config.OIDC_ISSUER_URL}/`,
  );

  const response = await fetch(discoveryUrl, { signal: AbortSignal.timeout(5_000) }).catch(
    (cause: unknown) => {
      throw new DependencyUnavailableError('oidc-discovery', { cause });
    },
  );

  if (!response.ok) {
    throw new DependencyUnavailableError(
      `oidc-discovery (${String(response.status)} from ${discoveryUrl.toString()})`,
    );
  }

  const document = (await response.json()) as DiscoveryDocument;

  if (typeof document.issuer === 'string' && document.issuer !== config.OIDC_ISSUER_URL) {
    // A discovery document declaring a different issuer than the one configured means the URL
    // points somewhere unintended. Refusing beats trusting it.
    throw new DependencyUnavailableError(
      `oidc-discovery (issuer mismatch: configured ${config.OIDC_ISSUER_URL}, document declares ${document.issuer})`,
    );
  }

  if (typeof document.jwks_uri !== 'string' || document.jwks_uri === '') {
    throw new DependencyUnavailableError('oidc-discovery (no jwks_uri in discovery document)');
  }

  return document.jwks_uri;
}

export interface JwksOptions {
  /** How long a fetched key set is trusted before it is refreshed. */
  readonly cacheMaxAgeMs?: number;
  /** Minimum interval between refetches triggered by an unknown `kid`. */
  readonly cooldownMs?: number;
}

export function createJwks(config: GatewayConfig, options: JwksOptions = {}): Jwks {
  let pending: Promise<{ uri: string; getKey: JWTVerifyGetKey }> | undefined;

  async function load(): Promise<{ uri: string; getKey: JWTVerifyGetKey }> {
    const uri = await resolveJwksUri(config);
    return {
      uri,
      getKey: createRemoteJWKSet(new URL(uri), {
        // Ten minutes: short enough that a rotation is picked up without anyone intervening,
        // long enough that the IdP is not fielding a request per token.
        cacheMaxAge: options.cacheMaxAgeMs ?? 10 * 60_000,
        // A token with an unfamiliar `kid` refetches, but at most this often. Without a
        // cooldown, an attacker sending tokens with random `kid` values turns this service into
        // a load generator aimed at the identity provider.
        cooldownDuration: options.cooldownMs ?? 30_000,
        timeoutDuration: 5_000,
      }),
    };
  }

  function resolved(): Promise<{ uri: string; getKey: JWTVerifyGetKey }> {
    // A failure is not memoised: clearing the slot means the next request retries, so an IdP
    // that comes back does not need this process restarted.
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  }

  return {
    getKey: async (protectedHeader, token) => {
      const { getKey } = await resolved();
      return getKey(protectedHeader, token);
    },
    resolveUri: async () => (await resolved()).uri,
  };
}
