import { DriftRaiseResponse } from 'protocol';

/**
 * The drift client, in the service worker.
 *
 * One route — `POST /v1/drift` — called with the scoped token, which never crosses into the page.
 * Same shape and same division of labour as the session, memory, escalation, alias and seed
 * clients: this is transport, and the caller above it decides what to do with an answer.
 *
 * ## Nothing waits for this
 *
 * `DriftRaiseRequest` calls itself "a *notification*, not a request for anything", and
 * `BUILD-PLAN.md` Phase 17 requires that drift never block the tester. So the only method here
 * resolves to an outcome and is called without being awaited on any tester-visible path. A gateway
 * that is down costs a report, not a resolution.
 *
 * ## Why the session id is the worker's
 *
 * The gateway reads the memory version from the session rather than from the request body,
 * precisely so a client cannot report drift against a version it never loaded. The worker opened
 * that session; the content script has neither its id nor the token. The page side sends what only
 * it can observe — the screen, the route and the two hashes — and the worker completes the request.
 *
 * ## Deduplication is not done here
 *
 * A tester working on a drifted screen settles on it repeatedly, and each settle detects again.
 * `DriftRaiseResponse` is explicit that this is the ordinary case and that the gateway is what
 * collapses it: "Deduplicating server-side — rather than asking the extension to remember what it
 * has sent — keeps the rule in one place and survives a service worker restart." This client
 * therefore keeps no history of what it has sent. It holds only an in-flight guard, which is a
 * different thing: it stops one observation being POSTed twice concurrently, and forgets it the
 * moment the request settles.
 */

export const DRIFT_RAISE_PATH = '/v1/drift';

/** Why a raise produced nothing. Mirrors the closed sets the other worker clients use. */
export type DriftFailure = 'unavailable' | 'timeout' | 'invalid' | 'failed';

export type DriftRaiseOutcome =
  | { readonly ok: true; readonly value: DriftRaiseResponse }
  | { readonly ok: false; readonly reason: DriftFailure; readonly detail: string | null }
  /** An identical observation was already in flight. Not a failure — the first one is doing the work. */
  | { readonly ok: false; readonly reason: 'duplicate'; readonly detail: null };

export interface DriftRaiseInput {
  readonly sessionId: string;
  readonly screenId: string;
  readonly routePattern: string;
  readonly route: string;
  readonly stateFingerprint: string;
  readonly expectedStructuralHash: string;
  readonly observedStructuralHash: string;
  readonly observedAt: string;
  readonly bearerToken: string;
}

export interface DriftClientOptions {
  /** Origin of the control plane. Must match the manifest's `host_permissions`. */
  readonly gatewayOrigin: string;
  /**
   * Ceiling for a raise.
   *
   * Short, and deliberately so. The gateway stores a row and enqueues a job; there is no model call
   * and no browser behind this. Nothing waits for the answer either, so a generous timeout would
   * only hold a request open against a gateway that has already stopped answering.
   */
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface DriftClient {
  raise(input: DriftRaiseInput): Promise<DriftRaiseOutcome>;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** Map a gateway failure onto the closed set the caller can log. */
function reasonFor(status: number): DriftFailure {
  if (status === 400 || status === 422) return 'invalid';
  if (status >= 500 || status === 429) return 'unavailable';
  return 'failed';
}

/**
 * The identity of one observation, for the in-flight guard.
 *
 * The screen and the hash it was seen at. The route is left out on purpose: two concrete paths of
 * the same pattern that drifted the same way are the same finding, and the gateway would collapse
 * them into one report anyway.
 */
function keyOf(input: DriftRaiseInput): string {
  return `${input.screenId}:${input.observedStructuralHash}`;
}

export function createDriftClient(options: DriftClientOptions): DriftClient {
  const {
    gatewayOrigin,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
  } = options;

  const inFlight = new Set<string>();

  return {
    async raise(input: DriftRaiseInput): Promise<DriftRaiseOutcome> {
      const key = keyOf(input);
      if (inFlight.has(key)) return { ok: false, reason: 'duplicate', detail: null };
      inFlight.add(key);

      try {
        return await post(input);
      } finally {
        inFlight.delete(key);
      }
    },
  };

  async function post(input: DriftRaiseInput): Promise<DriftRaiseOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(new URL(DRIFT_RAISE_PATH, gatewayOrigin).href, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${input.bearerToken}`,
        },
        body: JSON.stringify({
          sessionId: input.sessionId,
          screenId: input.screenId,
          routePattern: input.routePattern,
          route: input.route,
          stateFingerprint: input.stateFingerprint,
          expectedStructuralHash: input.expectedStructuralHash,
          observedStructuralHash: input.observedStructuralHash,
          observedAt: input.observedAt,
        }),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        reason: aborted ? 'timeout' : 'unavailable',
        detail: aborted ? null : error instanceof Error ? error.message : 'network error',
      };
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return { ok: false, reason: reasonFor(response.status), detail: await messageOf(response) };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: 'failed', detail: 'the gateway sent an unreadable response' };
    }

    // Validated before it is handed on, like every other response this worker receives. Nothing
    // renders from a drift report today, but a malformed one would otherwise reach the notice.
    const parsed = DriftRaiseResponse.safeParse(body);
    if (!parsed.success) {
      return { ok: false, reason: 'failed', detail: 'the gateway sent a malformed drift report' };
    }
    return { ok: true, value: parsed.data };
  }
}

/** Read the protocol error message from a failed response, tolerating a missing body. */
async function messageOf(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'message' in body) {
      return typeof body.message === 'string' ? body.message : null;
    }
  } catch {
    // A body-less or non-JSON failure is classified by status alone.
  }
  return null;
}
