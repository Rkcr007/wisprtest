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
