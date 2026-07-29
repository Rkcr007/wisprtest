import { defaultRedactor, type Redactor } from 'fingerprint';
import type { EscalateRequest, EscalateResponse } from 'protocol';

import { GatewayError } from '../errors.js';
import {
  ESCALATION_REPAIR_INSTRUCTION,
  ESCALATION_SYSTEM_PROMPT,
  buildUserPrompt,
  parseEscalation,
} from './prompt.js';
import { ModelError, type ModelMessage, type ModelProvider } from './provider.js';

/**
 * The escalation service: everything between a validated request and a validated pick.
 *
 * This is where CLAUDE.md § "Resolution tiers" and the Phase 11 prompt are enforced:
 *
 * - **Redaction before the prompt.** Every candidate label and the utterance pass through the
 *   shared redactor again before they are rendered — defence in depth over the contract's
 *   `RedactedText`, and the thing the test asserts so a customer's data can never reach a provider.
 * - **A hard budget.** One deadline covers the whole escalation, primary and fallback and a repair
 *   retry alike. When it passes, the caller gets a typed `resolution_timeout` and the extension
 *   falls back to disambiguation rather than hanging on a slow model.
 * - **Never an unvalidated result.** A 2xx whose body does not parse to an in-list pick earns one
 *   repair retry; if that also fails the honest answer is `resolution_not_found`, not a guess.
 * - **A configured fallback.** A fast transport failure on the primary model tries the fallback
 *   within the remaining budget; a timeout does not, because there is no budget left to spend.
 */

/** A generous ceiling: an element id, a confidence and a one-line reason need very few tokens. */
const MAX_TOKENS = 256;

export interface EscalationDeps {
  readonly provider: ModelProvider;
  readonly primaryModel: string;
  readonly fallbackModel: string;
  /** The hard budget for the whole call, in milliseconds. 800 ms in production. */
  readonly budgetMs: number;
  /** Defence-in-depth redactor. Defaults to the shared one used across the codebase. */
  readonly redact?: Redactor;
  /** Clock, injectable for deterministic budget tests. */
  readonly now?: () => number;
}

export interface EscalationOutcome {
  readonly response: EscalateResponse;
  /** Which model actually produced the pick — telemetry, and the record of what resolved the phrase. */
  readonly model: string;
  readonly elapsedMs: number;
}

export async function runEscalation(
  request: EscalateRequest,
  deps: EscalationDeps,
): Promise<EscalationOutcome> {
  const redact = deps.redact ?? defaultRedactor;
  const now = deps.now ?? (() => performance.now());

  const redacted = redactRequest(request, redact);
  const candidateIds = new Set(redacted.candidates.map((candidate) => candidate.elementId));
  const userPrompt = buildUserPrompt(redacted);

  const startedAt = now();
  const deadline = startedAt + deps.budgetMs;

  // Distinct models only: when primary and fallback are configured the same, there is no second
  // provider to try, so a parse failure is final rather than the same model asked twice.
  const models =
    deps.primaryModel === deps.fallbackModel
      ? [deps.primaryModel]
      : [deps.primaryModel, deps.fallbackModel];

  let sawCompletion = false;

  for (let m = 0; m < models.length; m += 1) {
    const model = models[m];
    if (model === undefined) continue;
    // The repair retry is spent on the primary model only, to keep the worst case at three calls
    // (primary, primary-repair, fallback) rather than an open-ended fan-out under one budget.
    const maxAttempts = m === 0 ? 2 : 1;

    let messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const signal = signalForDeadline(deadline, now, deps.budgetMs, startedAt);

      let text: string;
      try {
        const completion = await deps.provider.complete({
          model,
          system: ESCALATION_SYSTEM_PROMPT,
          messages,
          maxTokens: MAX_TOKENS,
          signal,
        });
        text = completion.text;
      } catch (error: unknown) {
        if (error instanceof ModelError) {
          // A timeout means the budget is gone; there is nothing left to spend on a fallback.
          if (error.kind === 'timeout') throw timeout(deps.budgetMs, now() - startedAt);
          // A fast transport failure abandons this model and lets the loop try the next one.
          break;
        }
        throw error;
      }

      sawCompletion = true;
      const pick = parseEscalation(text, candidateIds);
      if (pick !== null) return { response: pick, model, elapsedMs: now() - startedAt };

      // Parsed nothing usable. If a repair attempt remains, show the model its own answer and the
      // repair instruction; otherwise this model is done.
      messages = [
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: text },
        { role: 'user', content: ESCALATION_REPAIR_INSTRUCTION },
      ];
    }
  }

  // Exhausted every model. If one answered but none produced a usable pick, that is an honest
  // "not found" the extension disambiguates; if nothing answered at all, it is a timeout it retries.
  if (sawCompletion) {
    throw new GatewayError(
      'resolution_not_found',
      'T2 escalation did not resolve the phrase to a candidate',
      { tier: 'T2', targetPhrase: redacted.utterance },
    );
  }
  throw timeout(deps.budgetMs, now() - startedAt);
}

/** Redact the utterance and every candidate label before any of it is rendered into a prompt. */
function redactRequest(request: EscalateRequest, redact: Redactor): EscalateRequest {
  return {
    ...request,
    utterance: redact(request.utterance),
    candidates: request.candidates.map((candidate) => ({
      ...candidate,
      label: redact(candidate.label),
    })),
  };
}

/**
 * An abort signal that fires when the shared deadline passes, or a thrown timeout if it already has.
 *
 * Throwing when there is no time left, rather than making a call with a zero-length signal, keeps a
 * spent budget from turning into a request that is aborted the instant it is made.
 */
function signalForDeadline(
  deadline: number,
  now: () => number,
  budgetMs: number,
  startedAt: number,
): AbortSignal {
  const remaining = deadline - now();
  if (remaining <= 0) throw timeout(budgetMs, now() - startedAt);
  // `AbortSignal.timeout` takes an integer delay and throws a RangeError on the fractional
  // milliseconds `performance.now()` produces. Rounding up rather than down keeps the budget from
  // being shaved by a sub-millisecond on every attempt, and `remaining > 0` guarantees at least 1.
  return AbortSignal.timeout(Math.ceil(remaining));
}

function timeout(budgetMs: number, elapsedMs: number): GatewayError {
  return new GatewayError('resolution_timeout', 'T2 escalation exceeded its budget', {
    tier: 'T2',
    budgetMs,
    elapsedMs,
  });
}
