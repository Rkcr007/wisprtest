import type {
  ActionVerb,
  ElementRecord,
  ResolutionCandidate,
  ResolutionResult,
  ScopedQuery,
  Tier,
} from 'protocol';

import { type PageContext, resolveContext, type ResolvedContext } from './config.js';
import { fingerprintWith } from './fingerprint.js';
import { compareFingerprints, textSimilarity } from './score.js';

/**
 * The scoring resolver.
 *
 * ## A deviation from the signature in docs/ARCHITECTURE.md § 2, stated up front
 *
 * The architecture document writes this as `resolve(query: ScopedQuery, candidates: Element[])`.
 * That signature cannot produce the return type. `ResolutionResult` requires `elementId` — a
 * UUID — and `elementKey`, and a live DOM node carries neither: both live in memory, on
 * `ElementRecord`. Scoring is impossible for the same reason, since `scoreCandidate` needs a
 * stored fingerprint to compare against.
 *
 * So each candidate is passed as the pair the work actually needs: the live element together
 * with the memory record it is believed to be. Arity and parameter names are unchanged, and
 * pairing them in one object rather than taking two parallel arrays makes it impossible to hand
 * in an element without its record. `packages/protocol` was not modified to accommodate this.
 *
 * ## What resolution decides, and how
 *
 * Two questions, kept separate:
 *
 * 1. **Affinity** — does this element match what the tester said? Their phrase against the
 *    element's live accessible name and its element key. This decides the ranking.
 * 2. **Integrity** — is this element still the one memory recorded? The stored fingerprint
 *    against the live node, via `scoreCandidate`. This discounts, it does not decide.
 *
 * Integrity discounts rather than filters because a drifted element is still an element the
 * tester can see and point at. Excluding it would make the resolver blind to exactly the
 * controls a drift report is about; discounting it lowers confidence, which pushes towards
 * disambiguation — the behaviour the reversibility taxonomy asks for.
 *
 * ## It never picks below threshold
 *
 * A candidate is named only when it clears `resolutionThreshold` *and* leads the runner-up by
 * `resolutionMargin`. Two controls at 0.91 and 0.90 are an ambiguity that happens to clear the
 * bar, not a resolution. Otherwise the ranked list is returned for disambiguation.
 */

/**
 * A live element together with the memory record it is believed to be.
 *
 * The record supplies the identity the result must carry — `id` and `elementKey` — and the
 * stored fingerprint that integrity is measured against.
 */
export interface ScopedCandidate {
  readonly record: ElementRecord;
  readonly element: Element;
}

export interface ResolveOptions {
  /**
   * The tier this resolution is being performed as. Defaults to `T0`.
   *
   * This package implements the scoring that T0 and T1 both dispatch through; which tier is
   * running is the caller's knowledge, not something the scorer can infer. Phase 8 supplies it.
   */
  readonly tier?: Tier;

  /** Fingerprinting context — geometry, redaction, weights. */
  readonly context?: PageContext;

  /** Clock, for deterministic latency in tests. Defaults to `performance.now`. */
  readonly now?: () => number;
}

/**
 * Roles each verb can meaningfully act on.
 *
 * A verb is a strong hint about what the tester means: "type Acme Industrial" is aimed at a
 * field, not at the label sitting next to it, even though the label's text matches better. A
 * candidate whose role is not in its verb's list keeps only `VERB_MISMATCH_FACTOR` of its
 * affinity — a discount rather than an exclusion, because an application that puts a
 * `role="button"` on a real input should still be operable.
 *
 * Verbs absent from this map — `check`, `back` — constrain nothing.
 */
const VERB_ROLES: Partial<Record<ActionVerb, readonly string[]>> = {
  type: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  select: ['combobox', 'listbox', 'option', 'menu'],
  click: ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'summary'],
  navigate: ['link', 'button', 'tab', 'menuitem'],
  focus: ['textbox', 'searchbox', 'combobox', 'spinbutton', 'button', 'link', 'checkbox', 'radio'],
  filter: ['textbox', 'searchbox', 'combobox', 'button', 'checkbox', 'switch', 'tab', 'radio'],
  scroll: ['region', 'main', 'list', 'table', 'grid', 'generic'],
};

const VERB_MISMATCH_FACTOR = 0.55;

function defaultNow(): number {
  return typeof performance === 'object' ? performance.now() : Date.now();
}

/** Linear interpolation from `floor` at `t = 0` to `1` at `t = 1`. */
function lerpFromFloor(floor: number, t: number): number {
  return floor + (1 - floor) * t;
}

interface Scored {
  readonly candidate: ResolutionCandidate;
  readonly affinity: number;
}

export function resolve(
  query: ScopedQuery,
  candidates: readonly ScopedCandidate[],
  options: ResolveOptions = {},
): ResolutionResult {
  const now = options.now ?? defaultNow;
  const startedAt = now();

  const tier = options.tier ?? 'T0';
  const context = resolveContext(options.context);
  const { config } = context;

  const scoped = applyScope(query, candidates);
  const ranked = scoped
    .map((candidate) => score(query, candidate, context))
    .sort((a, b) => b.candidate.confidence - a.candidate.confidence);

  const shortlist = ranked
    .filter((entry) => entry.candidate.confidence >= config.candidateFloor)
    .map((entry) => entry.candidate);

  const ordinal = ordinalConstraint(query);
  if (ordinal !== undefined) {
    return byOrdinal(shortlist, ordinal, tier, now() - startedAt);
  }

  const best = shortlist[0];
  const runnerUp = shortlist[1];

  if (best !== undefined && best.confidence >= config.resolutionThreshold) {
    const lead = best.confidence - (runnerUp?.confidence ?? 0);
    if (runnerUp === undefined || lead >= config.resolutionMargin) {
      return {
        outcome: 'resolved',
        elementId: best.elementId,
        elementKey: best.elementKey,
        confidence: best.confidence,
        tier,
        latencyMs: now() - startedAt,
        candidates: shortlist,
      };
    }
  }

  if (shortlist.length >= 2) {
    return { outcome: 'ambiguous', tier, latencyMs: now() - startedAt, candidates: shortlist };
  }

  // A single sub-threshold candidate is not an ambiguity — there is nothing to choose between —
  // and `ResolutionResult`'s `ambiguous` arm requires at least two. Reporting `not_found` is the
  // contract's way of saying the phrase did not match, which is the honest answer: offering one
  // weak guess as a disambiguation prompt is the guess the resolver is not allowed to make.
  return { outcome: 'not_found', tier, latencyMs: now() - startedAt, candidates: [] };
}

/**
 * Narrow the candidates to the query's scope.
 *
 * `ScopedQuery.candidateElementKeys` is the visible ∩ reachable set the runtime state engine
 * produced, and the contract is explicit that it is "the only set resolution may search".
 * Anything else in `candidates` is dropped rather than scored — scoping is what keeps T0 inside
 * 15 ms, and a resolver that quietly widened its own search would break both the latency budget
 * and the accuracy that comes from a small candidate set.
 *
 * `within` constraints narrow it further, by landmark.
 */
function applyScope(
  query: ScopedQuery,
  candidates: readonly ScopedCandidate[],
): readonly ScopedCandidate[] {
  const scope = new Set(query.candidateElementKeys);
  const withinLandmarks = query.constraints
    .filter((constraint) => constraint.kind === 'within')
    .map((constraint) => constraint.landmark.toLowerCase());

  return candidates.filter((candidate) => {
    if (!scope.has(candidate.record.elementKey)) return false;
    if (withinLandmarks.length === 0) return true;

    const path = candidate.record.fingerprint.landmarkPath.map((entry) => entry.toLowerCase());
    return withinLandmarks.every((landmark) =>
      path.some(
        (entry) =>
          entry === landmark || entry.startsWith(`${landmark}:`) || entry.endsWith(`:${landmark}`),
      ),
    );
  });
}

function score(query: ScopedQuery, candidate: ScopedCandidate, context: ResolvedContext): Scored {
  const { record, element } = candidate;
  const live = fingerprintWith(element, context);

  const integrity = compareFingerprints(record.fingerprint, live, context).score;
  const verb = verbFactor(query.verb, live.role);
  const affinity = phraseAffinity(query, record, live.accessibleNameRedacted) * verb;

  const confidence = affinity * lerpFromFloor(context.config.integrityFloor, integrity);

  return {
    affinity,
    candidate: {
      elementId: record.id,
      elementKey: record.elementKey,
      label: live.accessibleNameRedacted,
      confidence,
      // The breakdown the disambiguation UI and the session step read: what the resolver
      // weighed, not just what it concluded.
      signalScores: { affinity, integrity, verb },
    },
  };
}

/**
 * How well the utterance matches this element, in [0, 1].
 *
 * The live accessible name carries most of it. The element key contributes a floor, because a
 * tester saying "pending filter" against `orders.filter.pending` is a match even on a screen
 * where the control is labelled with an icon and has no useful name at all.
 */
function phraseAffinity(query: ScopedQuery, record: ElementRecord, liveName: string): number {
  const phrase = query.targetPhrase;
  const byName = textSimilarity(phrase, liveName);
  const byKey = textSimilarity(phrase, record.elementKey.replace(/[._-]+/g, ' '));

  return Math.max(byName, byKey);
}

function verbFactor(verb: ActionVerb, role: string): number {
  const allowed = VERB_ROLES[verb];
  if (allowed === undefined) return 1;
  return allowed.includes(role) ? 1 : VERB_MISMATCH_FACTOR;
}

function ordinalConstraint(query: ScopedQuery): number | undefined {
  for (const constraint of query.constraints) {
    if (constraint.kind === 'ordinal') return constraint.index;
  }
  return undefined;
}

/**
 * Apply an explicit ordinal — "the second one".
 *
 * Indexes the same shortlist the tester was offered, one-based as it is spoken. Neither the
 * threshold nor the margin applies: an ordinal is what a tester says *after* the resolver
 * reported an ambiguity, so by construction every candidate is below threshold and separated by
 * less than the margin. Re-imposing either would make disambiguation impossible to complete.
 *
 * An index past the end of the list is a miss, not a wrap-around — "the fourth one" when three
 * were offered means the tester is looking at something the resolver never found.
 */
function byOrdinal(
  shortlist: readonly ResolutionCandidate[],
  index: number,
  tier: Tier,
  latencyMs: number,
): ResolutionResult {
  const chosen = shortlist[index - 1];
  if (chosen === undefined) {
    return { outcome: 'not_found', tier, latencyMs, candidates: [] };
  }

  return {
    outcome: 'resolved',
    elementId: chosen.elementId,
    elementKey: chosen.elementKey,
    confidence: chosen.confidence,
    tier,
    latencyMs,
    candidates: [chosen],
  };
}
