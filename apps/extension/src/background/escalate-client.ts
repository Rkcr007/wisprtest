import { EscalateResponse, type EscalateRequest } from 'protocol';

import type { EscalationOutcome } from '../resolver/index.js';

/**
 * The T2 escalation client, in the service worker.
 *
 * `POST /v1/resolve/escalate`, with the scoped token attached. It lives here rather than in the
 * content script for the same reason the snapshot fetch does: the token never crosses into the
 * page (see `messaging.ts`), so a compromised application under test cannot read a credential or
 * spend a tenant's model budget.
 *
 * ## Never throws, always reports
 *
 * Every failure — a timeout, a 5xx, an unreachable gateway, a body that is not an `EscalateResponse`
 * — comes back as `{ ok: false, reason }`. The resolver reads that and falls back to the ranked T1
 * candidates the tester can disambiguate. There is no path here that leaves a resolution hanging or
 * that surfaces an exception on the hot path.
 *
 * ## Two budgets, deliberately
 *
 * The gateway enforces the real one — 800 ms, after which it returns a typed `resolution_timeout`.
 * This client's own deadline sits above it, and exists only for the case where the *connection*
 * hangs and no typed error ever arrives. It is a guard, not the budget.
 */

/** The route this client calls. */
export const ESCALATE_PATH = '/v1/resolve/escalate';

/** Comfortably above the gateway's 800 ms budget: this fires only when nothing comes back at all. */
const DEFAULT_TIMEOUT_MS = 2_000;

export interface EscalateClientOptions {
  /** Origin of the control plane. Must match the manifest's `host_permissions`. */
  readonly gatewayOrigin: string;
  /** The connection guard, not the resolution budget. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface EscalateClient {
  escalate(request: EscalateRequest, bearerToken: string): Promise<EscalationOutcome>;
}

export function createEscalateClient(options: EscalateClientOptions): EscalateClient {
  const {
    gatewayOrigin,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
  } = options;
  const endpoint = new URL(ESCALATE_PATH, gatewayOrigin).href;

  return {
    async escalate(request, bearerToken): Promise<EscalationOutcome> {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${bearerToken}`,
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error: unknown) {
        // An aborted fetch is the guard firing; anything else is the network. Both leave the
        // tester with the T1 candidates, so they are only distinguished for the log.
        return { ok: false, reason: isAbort(error) ? 'timeout' : 'unavailable' };
      }

      if (!response.ok) {
        const code = await codeOf(response);
        if (code === 'resolution_timeout') return { ok: false, reason: 'timeout' };
        // The gateway refuses a pick it could not validate — including an element id the model
        // invented — and reports it as a clean not-found rather than passing a guess through.
        if (code === 'resolution_not_found') return { ok: false, reason: 'not_found' };
        return { ok: false, reason: 'unavailable' };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { ok: false, reason: 'unavailable' };
      }

      const parsed = EscalateResponse.safeParse(payload);
      // Validated before it is trusted: an unvalidated pick would be handed to the speculation
      // controller, and a malformed confidence there is a wrong click waiting to happen.
      if (!parsed.success) return { ok: false, reason: 'not_found' };

      return { ok: true, response: parsed.data };
    },
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Read the protocol error `code` from a failed response, tolerating a missing or invalid body. */
async function codeOf(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'code' in body) {
      const { code } = body;
      return typeof code === 'string' ? code : null;
    }
  } catch {
    // A body-less or non-JSON failure is treated as an unavailable gateway by the caller.
  }
  return null;
}
