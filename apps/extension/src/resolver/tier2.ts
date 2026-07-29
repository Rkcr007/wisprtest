import { defaultRedactor, type Redactor } from 'fingerprint';
import type {
  AliasWriteback,
  EscalateRequest,
  EscalateResponse,
  ResolutionCandidate,
  ResolutionResult,
} from 'protocol';

import type { BoundCandidate, ScreenBinding } from './candidate-binder.js';
import type { ResolverConfig } from './config.js';
import { normalizePhrase } from './normalize.js';

/**
 * Tier 2 — the escalation, and the write-back that makes it worth doing.
 *
 * T2 is the only tier that leaves the device, and it is reached for under 5% of commands: only
 * when T0 (alias) and T1 (embedding) have both failed to name an element (CLAUDE.md § "Resolution
 * tiers"). The scoped candidate set — dozens of elements, redacted — goes to the gateway, a small
 * fast model picks one, and the answer comes back inside an 800 ms budget the *gateway* enforces.
 *
 * ## The write-back is the point
 *
 * CLAUDE.md is blunt about it: "If you implement T2 without the write-back, you have implemented a
 * slower competitor." So every T2 resolution above threshold enqueues
 * `{ phrase, elementId, stateFingerprint, source: 't2_writeback' }`, and the phrase is normalised
 * by the *same* `normalizePhrase` that T0's alias index folds its keys with. That detail is the
 * whole loop: a phrase written back in any other form would be persisted, reloaded, and then miss
 * at T0 forever — an alias that exists and never fires is indistinguishable from no learning at
 * all. `tier2.test.ts` and the write-back loop suite both pin it.
 *
 * A pick *below* threshold is not written back. The threshold is the line between "the resolver
 * would act on this" and "the tester should choose", and persisting an uncertain pick as
 * vocabulary would make the same uncertain answer instant — and confident — next time.
 *
 * ## Failure is never fatal here
 *
 * A timeout, an unreachable gateway or a model that could not pick all return the T1 result the
 * caller already had: ranked candidates for disambiguation, or an honest "not found". The tester
 * gets a list to choose from, never a hang and never a guess — the worst case at T2 is one extra
 * spoken word, which is exactly what the reversibility taxonomy asks for.
 */

/** Why an escalation did not produce a pick. A closed set, so the caller can branch on it. */
export type EscalationFailure =
  /** The gateway's 800 ms budget ran out, or the extension's own guard fired first. */
  | 'timeout'
  /** The control plane was unreachable, or the worker had no attached session to ask through. */
  | 'unavailable'
  /** The model answered but produced nothing usable — the gateway refuses hallucinated ids. */
  | 'not_found';

export type EscalationOutcome =
  | { readonly ok: true; readonly response: EscalateResponse }
  | { readonly ok: false; readonly reason: EscalationFailure };

/**
 * How a T2 request reaches the gateway.
 *
 * A function rather than a client, because the content script cannot make this call itself: the
 * scoped token lives in the service worker and never crosses into the page (see `messaging.ts`).
 * The content script's transport posts over the HUD port and awaits the worker's reply; a test
 * passes a function. Either way this file has no knowledge of transport, credentials or retries.
 */
export type EscalateTransport = (request: EscalateRequest) => Promise<EscalationOutcome>;

/** Called with each learned mapping. The queue that batches these lives in the service worker. */
export type AliasSink = (writeback: AliasWriteback) => void;

export interface Tier2Options {
  readonly transport: EscalateTransport;
  /** Where a learned alias goes. Absent means escalate without learning — a degraded mode. */
  readonly onAlias?: AliasSink;
  /** Defence in depth over the fingerprint package's redaction. Defaults to the shared redactor. */
  readonly redact?: Redactor;
  readonly onError?: (error: unknown) => void;
}

export interface Tier2Resolver {
  /**
   * Escalate, and fold the answer into a result.
   *
   * `fallback` is what T1 produced — the ranked candidates or the not-found — and is what comes
   * back whenever the escalation cannot improve on it.
   */
  resolve(
    utterance: string,
    binding: ScreenBinding,
    config: ResolverConfig,
    startedAt: number,
    now: () => number,
    fallback: ResolutionResult,
  ): Promise<ResolutionResult>;
}

export function createTier2Resolver(options: Tier2Options): Tier2Resolver {
  const redact = options.redact ?? defaultRedactor;

  return {
    async resolve(utterance, binding, config, startedAt, now, fallback): Promise<ResolutionResult> {
      // Nothing in scope is nothing to choose between: there is no question to ask a model.
      if (binding.candidates.length === 0) return fallback;

      const phrase = redact(utterance);
      if (phrase.trim() === '') return fallback;

      const request: EscalateRequest = {
        utterance: phrase,
        stateFingerprint: binding.stateFingerprint,
        // Only the redacted accessible name crosses. The raw name has no field on the contract's
        // `EscalationCandidate`, so a leak here is unrepresentable rather than merely forbidden.
        candidates: binding.candidates.map((candidate) => ({
          elementId: candidate.record.id,
          elementKey: candidate.record.elementKey,
          label: redact(candidate.live.accessibleNameRedacted),
        })),
      };

      let outcome: EscalationOutcome;
      try {
        outcome = await options.transport(request);
      } catch (error: unknown) {
        // A transport that threw rather than reporting is still just an escalation that did not
        // happen. The tester disambiguates; the hot path does not surface an exception.
        options.onError?.(error);
        return fallback;
      }

      if (!outcome.ok) return fallback;

      const bound = binding.candidates.find(
        (candidate) => candidate.record.id === outcome.response.elementId,
      );
      // The gateway already refuses an id that was not offered; this is the second half of that
      // check, against the *live* scope rather than the request, and it closes the window where a
      // slow escalation returns an element the page has since removed.
      if (bound === undefined) return fallback;

      const latencyMs = now() - startedAt;
      const confidence = outcome.response.confidence;
      const picked = candidateOf(bound, confidence);

      if (confidence >= config.t2Threshold) {
        // The compounding loop. Normalised with the same function T0 folds its alias keys with,
        // so the next snapshot resolves this phrasing without leaving the device.
        writeBack(
          options.onAlias,
          phrase,
          bound.record.id,
          binding.stateFingerprint,
          't2_writeback',
        );

        return {
          outcome: 'resolved',
          elementId: bound.record.id,
          elementKey: bound.record.elementKey,
          confidence,
          tier: 'T2',
          latencyMs,
          candidates: [picked],
        };
      }

      // Below threshold: the model's pick leads a ranked list the tester chooses from by ordinal,
      // and nothing is learned until they do. Their choice is the higher-quality signal anyway.
      const ranked = rankFor(picked, fallback.candidates, config.disambiguationLimit);
      if (ranked.length >= 2) {
        return { outcome: 'ambiguous', tier: 'T2', latencyMs, candidates: ranked };
      }
      // One uncertain candidate is not a choice — there is no second option to say "two" for. The
      // honest answer is that nothing resolved, which is what the contract's `not_found` says.
      return { outcome: 'not_found', tier: 'T2', latencyMs, candidates: [] };
    },
  };
}

/**
 * Record a tester's correction as an alias.
 *
 * Exported because a disambiguation pick is a write-back too, and per the phase "a correction is
 * the highest-quality training signal available" — it is written back with `source: 'manual'`, so
 * the console can tell a model's guess from a human's answer when it prunes vocabulary.
 */
export function writeBackCorrection(
  sink: AliasSink | undefined,
  redactedPhrase: string,
  elementId: string,
  stateFingerprint: string,
): void {
  writeBack(sink, redactedPhrase, elementId, stateFingerprint, 'manual');
}

function writeBack(
  sink: AliasSink | undefined,
  redactedPhrase: string,
  elementId: string,
  stateFingerprint: string,
  source: AliasWriteback['source'],
): void {
  if (sink === undefined) return;
  const phrase = normalizePhrase(redactedPhrase);
  // An empty normalisation is a phrase made entirely of punctuation or stop characters. It could
  // never match at T0, so persisting it would grow the alias corpus without ever paying off.
  if (phrase === '') return;
  sink({ phrase, elementId, stateFingerprint, source });
}

function candidateOf(bound: BoundCandidate, confidence: number): ResolutionCandidate {
  return {
    elementId: bound.record.id,
    elementKey: bound.record.elementKey,
    label: bound.live.accessibleNameRedacted,
    confidence,
    signalScores: { model: confidence, integrity: bound.integrity },
  };
}

/** The model's pick first, then T1's ranking, deduplicated and capped at the spoken-list limit. */
function rankFor(
  picked: ResolutionCandidate,
  fallbackCandidates: readonly ResolutionCandidate[],
  limit: number,
): ResolutionCandidate[] {
  const ranked: ResolutionCandidate[] = [picked];
  for (const candidate of fallbackCandidates) {
    if (ranked.length >= limit) break;
    if (candidate.elementId === picked.elementId) continue;
    ranked.push(candidate);
  }
  return ranked;
}
