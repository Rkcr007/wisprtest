import { z } from 'zod';

import {
  Confidence,
  ElementKey,
  LatencyMs,
  NonEmptyString,
  RedactedText,
  StateFingerprint,
  Uuid,
} from './primitives.js';
import { contract } from './registry.js';
import { ActionVerb, Tier } from './vocabulary.js';

/**
 * Resolution — turning a phrase into an element.
 *
 * Scoping is what makes T0/T1 fast *and* accurate: the runtime state engine narrows candidates
 * from thousands of DOM nodes to the dozens currently visible and reachable. Nothing in this
 * domain ever resolves against the full document.
 */

/**
 * A qualifier attached to the target phrase, extracted by the intent parser.
 *
 * Closed set: each kind is something the scored resolver can apply mechanically to a candidate
 * list. Anything richer is a constraint on *data*, not on an element, and belongs in
 * `ConstraintSet`.
 */
export const QueryConstraint = contract(
  'QueryConstraint',
  z
    .discriminatedUnion('kind', [
      z
        .strictObject({
          kind: z.literal('ordinal'),
          /** One-based as spoken: "the second one" is 2. */
          index: z.int().min(1),
        })
        .meta({
          title: 'QueryConstraintOrdinal',
          description: 'Positional pick: "the second one".',
        }),
      z.strictObject({ kind: z.literal('within'), landmark: NonEmptyString }).meta({
        title: 'QueryConstraintWithin',
        description: 'Scope to a landmark: "in the sidebar".',
      }),
      z.strictObject({ kind: z.literal('value'), text: RedactedText }).meta({
        title: 'QueryConstraintValue',
        description: 'Literal payload carried by the utterance, for type and filter verbs.',
      }),
    ])
    .describe('Qualifier narrowing the candidate set for a scoped query.'),
);
export type QueryConstraint = z.infer<typeof QueryConstraint>;

/**
 * The resolver's input: what the tester wants, and the state it must be resolved against.
 *
 * `candidateElementKeys` is the scope — the visible ∩ reachable set produced by the runtime
 * state engine. It is required, and it is what the tier budgets are measured against. A query
 * without a scope is not resolvable within budget and must be rejected, not widened.
 */
export const ScopedQuery = contract(
  'ScopedQuery',
  z
    .strictObject({
      verb: ActionVerb,
      /** The redacted phrase naming the target, e.g. "the pending filter". */
      targetPhrase: RedactedText.describe('Redacted phrase naming the intended element.'),
      constraints: z.array(QueryConstraint),
      stateFingerprint: StateFingerprint,
      /** The scoped candidate set. Resolution never looks outside it. */
      candidateElementKeys: z
        .array(ElementKey)
        .describe('Visible and reachable elements; the only set resolution may search.'),
    })
    .describe('A parsed utterance plus the scoped candidate set it must resolve against.'),
);
export type ScopedQuery = z.infer<typeof ScopedQuery>;

/**
 * One scored candidate.
 *
 * `signalScores` carries the per-signal breakdown from `packages/fingerprint` so the console
 * can explain a decision and so a disambiguation prompt can say *why* two candidates tied.
 */
export const ResolutionCandidate = contract(
  'ResolutionCandidate',
  z
    .strictObject({
      elementId: Uuid,
      elementKey: ElementKey,
      /** Redacted accessible name, for the disambiguation UI and spoken ordinals. */
      label: RedactedText,
      confidence: Confidence,
      /** Per-signal contributions, keyed by signal name. Empty for an exact alias hit. */
      signalScores: z.record(z.string(), z.number()),
    })
    .describe('A scored resolution candidate with its per-signal breakdown.'),
);
export type ResolutionCandidate = z.infer<typeof ResolutionCandidate>;

/**
 * The resolver's output.
 *
 * A discriminated union rather than a nullable element id, so that "resolved" and "ambiguous"
 * cannot be confused by a consumer that forgets to check the confidence. Below threshold the
 * resolver returns ranked candidates for disambiguation — it never picks.
 *
 * `candidates` is present on every outcome: it is the evidence trail written to the session
 * step, and the disambiguation UI reads it directly.
 */
export const ResolutionResult = contract(
  'ResolutionResult',
  z
    .discriminatedUnion('outcome', [
      z
        .strictObject({
          outcome: z.literal('resolved'),
          elementId: Uuid,
          elementKey: ElementKey,
          confidence: Confidence,
          tier: Tier,
          latencyMs: LatencyMs,
          candidates: z.array(ResolutionCandidate),
        })
        .meta({
          title: 'ResolutionResolved',
          description: 'Exactly one candidate scored at or above the confidence threshold.',
        }),
      z
        .strictObject({
          outcome: z.literal('ambiguous'),
          tier: Tier,
          latencyMs: LatencyMs,
          /** Ranked best-first. The disambiguation UI numbers these for spoken ordinals. */
          candidates: z.array(ResolutionCandidate).min(2),
        })
        .meta({
          title: 'ResolutionAmbiguous',
          description: 'No candidate cleared the threshold; ranked alternatives for the tester.',
        }),
      z
        .strictObject({
          outcome: z.literal('not_found'),
          tier: Tier,
          latencyMs: LatencyMs,
          candidates: z.array(ResolutionCandidate).max(0),
        })
        .meta({
          title: 'ResolutionNotFound',
          description: 'Nothing in the scoped candidate set matched the phrase at all.',
        }),
    ])
    .describe('Outcome of resolving a scoped query, with the tier and latency it cost.'),
);
export type ResolutionResult = z.infer<typeof ResolutionResult>;

/**
 * A candidate as it crosses to the T2 model — the only shape allowed to carry a candidate's text
 * off the device.
 *
 * `label` is the redacted accessible name: the model needs *something* legible to reason over, and
 * CLAUDE.md § "PII rule" permits the scrubbed display form and nothing else. The raw accessible
 * name has no field here, so a candidate whose name was not redacted cannot even be expressed —
 * the contract makes the leak unrepresentable rather than merely discouraged. `elementId` is what
 * the model returns to name its pick; `elementKey` is structure, a semantic hint like
 * `orders.filter.pending` that measurably helps a small model disambiguate.
 */
export const EscalationCandidate = contract(
  'EscalationCandidate',
  z
    .strictObject({
      elementId: Uuid,
      elementKey: ElementKey,
      /** Redacted accessible name — the only candidate text permitted to reach a model provider. */
      label: RedactedText,
    })
    .describe('One scoped candidate as presented to the T2 model, carrying only redacted text.'),
);
export type EscalationCandidate = z.infer<typeof EscalationCandidate>;

/**
 * The T2 escalation request: `POST /v1/resolve/escalate`.
 *
 * Sent only when T0 and T1 both fell below threshold (CLAUDE.md § "Resolution tiers"). It carries
 * the scoped candidate set — never the whole document — so the model reasons over the dozens of
 * elements currently reachable, which is what keeps the prompt small and the answer inside the
 * 800 ms budget. `utterance` is the redacted phrase; like every candidate `label`, it is scrubbed
 * before it leaves the extension.
 */
export const EscalateRequest = contract(
  'EscalateRequest',
  z
    .strictObject({
      /** The redacted phrase the tester spoke. Never the raw utterance. */
      utterance: RedactedText.describe('Redacted phrase to resolve against the candidate set.'),
      stateFingerprint: StateFingerprint,
      candidates: z
        .array(EscalationCandidate)
        .min(1)
        .describe('The scoped candidate set; the model may only pick from these.'),
    })
    .describe('A T2 escalation: a redacted phrase plus the scoped candidates to choose among.'),
);
export type EscalateRequest = z.infer<typeof EscalateRequest>;

/**
 * The T2 model's answer.
 *
 * Strict JSON: `elementId` names one of the request's candidates — the gateway rejects an id that
 * is not in the set rather than trusting a hallucinated one — `confidence` places the pick on the
 * same 0..1 scale every tier uses, and `reasoning` is the model's short justification. The
 * reasoning is safe to keep: the model only ever saw redacted labels, so it cannot echo customer
 * data it was never shown.
 *
 * There is no "no match" member on purpose. The model always returns its best candidate with a
 * confidence; a low confidence is what routes the tester to disambiguation, so "I am unsure" and
 * "it is this one, barely" are the same signal handled in one place.
 */
export const EscalateResponse = contract(
  'EscalateResponse',
  z
    .strictObject({
      elementId: Uuid.describe('The chosen candidate; must be one of the request candidates.'),
      confidence: Confidence,
      reasoning: NonEmptyString.describe("The model's short, PII-free justification for the pick."),
    })
    .describe("The T2 model's chosen candidate, its confidence, and why."),
);
export type EscalateResponse = z.infer<typeof EscalateResponse>;
