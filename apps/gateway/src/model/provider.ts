/**
 * The model provider abstraction.
 *
 * The T2 escalation route (docs/BUILD-PLAN.md Phase 11) is the only thing in the gateway that
 * calls a language model, and it does so through this narrow interface so a second provider is a
 * drop-in and a test injects a fake with no network. CLAUDE.md § "Resolution tiers" is explicit
 * that T2 is a *small fast* model — Haiku class — because the whole call has to fit an 800 ms
 * budget; the interface reflects that by taking a per-call `timeoutMs` and an `AbortSignal`
 * rather than leaving cancellation to the caller.
 *
 * What crosses this boundary is text the gateway has already redacted. The provider neither
 * redacts nor validates JSON — that is the escalation service's job — so this stays a transport,
 * and the one implementation that talks to a real API has nothing in it but the API.
 */

/** A single turn. The escalation prompt is one user message under a system instruction. */
export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface ModelRequest {
  /** The concrete model id — the primary or the fallback, chosen by the caller. */
  readonly model: string;
  /** The system instruction: the task, the rules, and the demand for strict JSON. */
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  /** A ceiling on the answer. An element pick plus a one-line reason needs very little. */
  readonly maxTokens: number;
  /** Cancels the request; the caller sets it from the remaining budget. */
  readonly signal: AbortSignal;
}

export interface ModelResponse {
  /** The raw text the model produced. Parsed and validated by the escalation service, not here. */
  readonly text: string;
  /** The model that actually answered, for telemetry and for the ledger of which tier resolved. */
  readonly model: string;
}

export interface ModelProvider {
  /**
   * Complete one request, or throw a typed {@link ModelError}.
   *
   * Never returns a partial or an error sentinel: a caller that gets a value gets a real
   * completion, and every failure is a typed throw it can branch on.
   */
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/** Why a model call failed, as a closed set the escalation service maps to a typed gateway error. */
export type ModelErrorKind =
  /** The request was aborted — almost always the budget running out. Maps to a resolution_timeout. */
  | 'timeout'
  /** The provider was unreachable or returned a non-2xx. Fast enough that a fallback may still fit. */
  | 'unavailable'
  /** The provider answered 2xx but the body was not the shape its own API documents. */
  | 'malformed';

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  /** The model that was being called, so a fallback attempt logs which one failed. */
  readonly model: string;

  constructor(kind: ModelErrorKind, model: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelError';
    this.kind = kind;
    this.model = model;
  }
}
