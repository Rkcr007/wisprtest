import {
  SeedExecuteResponse,
  SeedPlanResponse,
  SeedRevertResponse,
  type RuntimeState,
} from 'protocol';

/**
 * The seed client, in the service worker.
 *
 * Plan, approve, revert — the three routes of `/v1/seed`, called with the scoped token, which never
 * crosses into the page. Same shape as the session, memory, escalation and alias clients, and the
 * same division of labour: this is transport, and the controller above it decides what to do with
 * an answer.
 *
 * ## Why it lives in the worker rather than the content script
 *
 * Two reasons, and the second is the one that matters. The token is worker-side, as it is for every
 * other gateway call. But so are the `sessionId` and the `applicationId` — the worker opened the
 * session when the snapshot loaded, and it holds the token that names the application. The content
 * script has neither and should not: a page the extension does not control has no business being
 * handed the identifier that scopes writes to a customer's application. So the HUD sends what only
 * it knows — the utterance and the runtime state — and the worker completes the request.
 *
 * ## Failures are outcomes, not exceptions
 *
 * Every method resolves. A seed request that could not be made is a card that says so, never an
 * unhandled rejection in a service worker that Chrome is about to terminate anyway. `forbidden` is
 * distinguished from the rest because it is the one failure a tester can do nothing about: seeding
 * is not enabled for this application, which is policy (`seeding_forbidden`), not an outage.
 */

export const SEED_PLAN_PATH = '/v1/seed/plan';
export const SEED_EXECUTE_PATH = '/v1/seed/execute';
export const SEED_REVERT_PATH = '/v1/seed/revert';

/** Mirrors `SeedFailureReason` in `seed/controller.ts`; the port carries it between the two. */
export type SeedFailure = 'unavailable' | 'timeout' | 'forbidden' | 'invalid' | 'failed';

export type SeedCallOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: SeedFailure; readonly detail: string | null };

export interface SeedClientOptions {
  /** Origin of the control plane. Must match the manifest's `host_permissions`. */
  readonly gatewayOrigin: string;
  /**
   * Ceiling for a plan call.
   *
   * CLAUDE.md § "Performance budgets" puts composition preview at 1.2 s p95, and the gateway calls
   * the composer behind this. Generous against that budget, because the alternative to waiting is a
   * card that says the gateway did not answer while it is in fact still composing.
   */
  readonly planTimeoutMs?: number;
  /**
   * Ceiling for execute and revert.
   *
   * Much longer, and deliberately: the UI adapter drives a real form in a real browser, which
   * § 4 measures in seconds — "3–15 s" — and a revert drives a real delete flow. Timing out under
   * that would abandon a request that is going to create a record anyway, leaving the tester with
   * a row nobody told them about.
   */
  readonly writeTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface SeedClient {
  plan(input: {
    sessionId: string;
    applicationId: string;
    utterance: string;
    runtimeState: RuntimeState;
    bearerToken: string;
  }): Promise<SeedCallOutcome<SeedPlanResponse>>;
  execute(input: {
    sessionId: string;
    planId: string;
    approvedAt: string;
    bearerToken: string;
  }): Promise<SeedCallOutcome<SeedExecuteResponse>>;
  revert(input: {
    scope: { kind: 'entry'; ledgerEntryId: string } | { kind: 'session'; sessionId: string };
    bearerToken: string;
  }): Promise<SeedCallOutcome<SeedRevertResponse>>;
}

const DEFAULT_PLAN_TIMEOUT_MS = 10_000;
const DEFAULT_WRITE_TIMEOUT_MS = 60_000;

/** Map a gateway failure onto the closed set the HUD can phrase. */
function reasonFor(status: number, code: string | null): SeedFailure {
  if (code === 'seeding_forbidden') return 'forbidden';
  if (status === 403) return 'forbidden';
  if (status === 400 || status === 422) return 'invalid';
  if (status >= 500 || status === 429) return 'unavailable';
  return 'failed';
}

export function createSeedClient(options: SeedClientOptions): SeedClient {
  const {
    gatewayOrigin,
    planTimeoutMs = DEFAULT_PLAN_TIMEOUT_MS,
    writeTimeoutMs = DEFAULT_WRITE_TIMEOUT_MS,
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
  } = options;

  const url = (path: string): string => new URL(path, gatewayOrigin).href;

  async function post(
    path: string,
    body: unknown,
    bearerToken: string,
    timeoutMs: number,
  ): Promise<SeedCallOutcome<unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearerToken}` },
        body: JSON.stringify(body),
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
      const failure = await failureOf(response);
      return {
        ok: false,
        reason: reasonFor(response.status, failure.code),
        detail: failure.message,
      };
    }

    try {
      return { ok: true, value: await response.json() };
    } catch {
      return { ok: false, reason: 'failed', detail: 'the gateway sent an unreadable response' };
    }
  }

  return {
    async plan(input): Promise<SeedCallOutcome<SeedPlanResponse>> {
      const outcome = await post(
        SEED_PLAN_PATH,
        {
          sessionId: input.sessionId,
          applicationId: input.applicationId,
          utterance: input.utterance,
          runtimeState: input.runtimeState,
          // Empty is a supported answer and means every reference is created rather than
          // fabricated — see `SeedPlanRequest`. Harvesting real records through the tester's live
          // session is the API adapter's read-back, which is Phase 16.
          existingRecords: [],
          // Entropy. A reproducible plan is a test concern; a tester asking twice for "an overdue
          // invoice" wants two different invoices, not the same one twice.
          seed: null,
        },
        input.bearerToken,
        planTimeoutMs,
      );
      return validate(outcome, SeedPlanResponse);
    },

    async execute(input): Promise<SeedCallOutcome<SeedExecuteResponse>> {
      const outcome = await post(
        SEED_EXECUTE_PATH,
        { sessionId: input.sessionId, planId: input.planId, approvedAt: input.approvedAt },
        input.bearerToken,
        writeTimeoutMs,
      );
      return validate(outcome, SeedExecuteResponse);
    },

    async revert(input): Promise<SeedCallOutcome<SeedRevertResponse>> {
      const body =
        input.scope.kind === 'entry'
          ? { scope: 'entry', ledgerEntryId: input.scope.ledgerEntryId }
          : { scope: 'session', sessionId: input.scope.sessionId };
      const outcome = await post(SEED_REVERT_PATH, body, input.bearerToken, writeTimeoutMs);
      return validate(outcome, SeedRevertResponse);
    },
  };
}

/** Read the protocol error `code` and message from a failed response, tolerating a missing body. */
async function failureOf(
  response: Response,
): Promise<{ code: string | null; message: string | null }> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const code = 'code' in body && typeof body.code === 'string' ? body.code : null;
      const message = 'message' in body && typeof body.message === 'string' ? body.message : null;
      return { code, message };
    }
  } catch {
    // A body-less or non-JSON failure is classified by status alone.
  }
  return { code: null, message: null };
}

/**
 * Validate a successful response against the contract before it is handed on.
 *
 * The same discipline the snapshot and the escalation get, and it earns its place twice over here:
 * a malformed `SeedPlanResponse` would be rendered as a preview card, and a tester would approve a
 * record described by a payload nothing has checked.
 */
function validate<T>(
  outcome: SeedCallOutcome<unknown>,
  schema: { safeParse: (input: unknown) => { success: boolean; data?: T } },
): SeedCallOutcome<T> {
  if (!outcome.ok) return outcome;
  const parsed = schema.safeParse(outcome.value);
  if (!parsed.success || parsed.data === undefined) {
    return { ok: false, reason: 'failed', detail: 'the gateway sent a malformed response' };
  }
  return { ok: true, value: parsed.data };
}
