import { ExtensionToken } from 'protocol';

/**
 * The scoped-token lifecycle.
 *
 * docs/ARCHITECTURE.md § 8: "the extension holds a short-lived scoped token refreshed by the
 * service worker". This is that client. Three behaviours, and each exists because of a specific
 * way the alternative fails a tester mid-session:
 *
 * **Refresh ahead of expiry.** A token discovered stale by a failing request costs a round trip
 * on the hot path, in the middle of a command. Refreshing at `expiresAt` minus a margin means
 * the failure never reaches a command.
 *
 * **Retry, but only what is worth retrying.** A network error or a 5xx is the control plane
 * having a bad moment and is retried with backoff. A 401 is not: retrying it hammers the identity
 * provider and can lock the tester's account, so it fails immediately and asks them to sign in.
 *
 * **Fail closed.** On any unrecoverable failure the cached token is dropped and an error is
 * thrown. There is no path that returns an expired token, and no path that proceeds without one.
 * A request made unauthenticated is either rejected by the gateway or — much worse, if anything
 * upstream is misconfigured — served without tenant scoping.
 *
 * ## What this does not do
 *
 * It does not talk to the identity provider. The exchange is authenticated by the tester's
 * existing console session cookie, which is why the fetch is `credentials: 'include'` and why the
 * extension never handles the tester's OIDC credentials at all.
 */

/** Thrown when the tester needs to sign in to the console. Never retried. */
export class UnauthenticatedError extends Error {
  readonly code = 'unauthenticated' as const;
  constructor() {
    super('the gateway rejected the session; sign in to the WisprTest console');
    this.name = 'UnauthenticatedError';
  }
}

/** Thrown when the control plane could not be reached or kept failing. */
export class GatewayUnreachableError extends Error {
  readonly code = 'unreachable' as const;
  constructor(detail: string) {
    super(`could not reach the gateway: ${detail}`);
    this.name = 'GatewayUnreachableError';
  }
}

/** Thrown when the gateway answered with something that is not an `ExtensionToken`. */
export class MalformedTokenError extends Error {
  readonly code = 'internal' as const;
  constructor(detail: string) {
    super(`the gateway returned a malformed token: ${detail}`);
    this.name = 'MalformedTokenError';
  }
}

export interface TokenClientOptions {
  /** Origin of the control plane. Must match the manifest's `host_permissions`. */
  readonly gatewayOrigin: string;
  /** Attempts per fetch, including the first. */
  readonly maxAttempts?: number;
  /** Base backoff, doubled per attempt. */
  readonly backoffMs?: number;
  /** Injected so tests do not sit through real backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly fetch?: typeof globalThis.fetch;
}

export interface TokenClient {
  /** A token for `origin`, minting one if necessary. */
  fetchToken(origin: string): Promise<ExtensionToken>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 250;

/** The route this client calls. Mirrors the `ExtensionTokenRequest` contract. */
export const TOKEN_PATH = '/v1/auth/extension-token';

export function createTokenClient(options: TokenClientOptions): TokenClient {
  const {
    gatewayOrigin,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    backoffMs = DEFAULT_BACKOFF_MS,
    sleep = defaultSleep,
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
  } = options;

  const endpoint = new URL(TOKEN_PATH, gatewayOrigin).href;

  return {
    async fetchToken(origin: string): Promise<ExtensionToken> {
      let lastFailure = 'no attempt was made';

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let response: Response;
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // The tester's console session authenticates this exchange. The extension holds no
            // credential of its own to present.
            credentials: 'include',
            body: JSON.stringify({ origin }),
          });
        } catch (error: unknown) {
          lastFailure = error instanceof Error ? error.message : 'network error';
          if (attempt === maxAttempts) break;
          await sleep(backoffMs * 2 ** (attempt - 1));
          continue;
        }

        // 401 and 403 are answers, not failures: the session is not valid, and asking again
        // with the same session will produce the same answer while counting against the
        // tester's account.
        if (response.status === 401 || response.status === 403) throw new UnauthenticatedError();

        if (response.status >= 500 || response.status === 429) {
          lastFailure = `HTTP ${String(response.status)}`;
          if (attempt === maxAttempts) break;
          await sleep(backoffMs * 2 ** (attempt - 1));
          continue;
        }

        if (!response.ok) {
          // A 4xx that is not an auth failure is a bug in this client or a contract mismatch.
          // Retrying would not fix either.
          throw new MalformedTokenError(`HTTP ${String(response.status)}`);
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch (error: unknown) {
          throw new MalformedTokenError(error instanceof Error ? error.message : 'invalid JSON');
        }

        const parsed = ExtensionToken.safeParse(payload);
        if (!parsed.success) {
          // Validated against the contract before it is trusted. An unvalidated token would be
          // stored, scheduled for refresh, and used — three ways for one bad response to spread.
          throw new MalformedTokenError(
            parsed.error.issues.map((issue) => issue.path.join('.') || 'root').join(', '),
          );
        }

        return parsed.data;
      }

      throw new GatewayUnreachableError(lastFailure);
    },
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Whether a token is still usable, with a margin.
 *
 * The margin is why this is a function rather than a comparison at the call site: a token that
 * expires in two seconds is not usable, because the request it is about to authorise takes
 * longer than that to arrive.
 */
export function isUsable(token: ExtensionToken, now: number, marginMs: number): boolean {
  return Date.parse(token.expiresAt) - now > marginMs;
}
