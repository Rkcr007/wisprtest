import type { ElementFingerprint } from 'protocol';

import { type PageContext, resolveContext, type ResolvedContext } from './config.js';
import { fingerprintWith } from './fingerprint.js';
import { bboxSimilarity } from './geometry.js';
import { landmarkPathSimilarity } from './landmarks.js';
import type { SignalName } from './config.js';

/**
 * Weighted scoring of a stored fingerprint against a live element.
 *
 * "Never XPath. Never a single CSS selector. Resolution is a weighted score with a threshold;
 * below threshold it escalates rather than guesses." — docs/ARCHITECTURE.md § 2.
 *
 * ## Applicability, and why it matters more than the weights
 *
 * Each signal reports whether it *applies* as well as how well it matches. A signal that cannot
 * be evaluated — no stable attributes on either side, no geometry because the page was measured
 * headless — is excluded and its weight redistributed over the signals that remain.
 *
 * Without this the scoring would be quietly broken. Most elements on most pages carry no
 * `data-testid`, so a fixed denominator would cap them at 0.80 no matter how perfectly
 * everything else matched, and the resolution threshold would have to be lowered to compensate —
 * which would in turn make the elements that *do* have a testid easier to confuse. Renormalising
 * keeps "how confident am I" separate from "how much evidence was available".
 *
 * A signal that is present on one side and absent on the other is a *mismatch*, not an
 * inapplicability. An element that has lost its `data-testid` has changed.
 */

/** One signal's contribution, before weighting. */
export interface SignalScore {
  /** How well the two sides agree, in [0, 1]. Meaningless when `applicable` is false. */
  readonly score: number;
  /** Whether there was anything to compare. Inapplicable signals are dropped, not zeroed. */
  readonly applicable: boolean;
}

/** The full breakdown, as `ResolutionCandidate.signalScores` carries it. */
export type SignalBreakdown = Partial<Record<SignalName, number>>;

export interface ScoreDetail {
  /** The weighted total across applicable signals, in [0, 1]. */
  readonly score: number;
  /** Per-signal scores, omitting signals that did not apply. */
  readonly signals: SignalBreakdown;
  /** Sum of the weights that were actually used. Low values mean thin evidence. */
  readonly evidence: number;
}

/**
 * Score a stored fingerprint against a live element, in [0, 1].
 *
 * The two-argument form in docs/ARCHITECTURE.md § 2. The optional context exists because the
 * indexer measures geometry in bulk rather than per element; omit it and the live element is
 * measured through `getBoundingClientRect` against its own window.
 */
export function scoreCandidate(
  fingerprint: ElementFingerprint,
  live: Element,
  context: PageContext = {},
): number {
  return scoreCandidateDetailed(fingerprint, live, resolveContext(context)).score;
}

/** {@link scoreCandidate}, keeping the per-signal breakdown for the disambiguation UI. */
export function scoreCandidateDetailed(
  fingerprint: ElementFingerprint,
  live: Element,
  context: ResolvedContext,
): ScoreDetail {
  return compareFingerprints(fingerprint, fingerprintWith(live, context), context);
}

/** Compare two fingerprints directly, for callers that already have both. */
export function compareFingerprints(
  stored: ElementFingerprint,
  live: ElementFingerprint,
  context: ResolvedContext,
): ScoreDetail {
  const signals: Record<SignalName, SignalScore> = {
    role: scoreRole(stored, live),
    accessibleName: scoreAccessibleName(stored, live),
    landmarkPath: {
      score: landmarkPathSimilarity(stored.landmarkPath, live.landmarkPath),
      applicable: true,
    },
    stableAttributes: scoreStableAttributes(stored, live),
    ordinal: scoreOrdinal(stored, live),
    textShingle: scoreTextShingle(stored, live),
    bbox: scoreBbox(stored, live),
  };

  const { weights } = context.config;
  const breakdown: SignalBreakdown = {};
  let weighted = 0;
  let evidence = 0;

  for (const [name, signal] of Object.entries(signals) as [SignalName, SignalScore][]) {
    if (!signal.applicable) continue;
    const weight = weights[name];
    breakdown[name] = signal.score;
    weighted += signal.score * weight;
    evidence += weight;
  }

  // No applicable signal at all is only reachable with every weight overridden to zero. Report
  // 0 rather than dividing by it: no evidence is not the same as a perfect match.
  return {
    score: evidence > 0 ? weighted / evidence : 0,
    signals: breakdown,
    evidence,
  };
}

/**
 * Role: binary. A control that changed role changed what it is, and a partial credit table
 * between `button` and `link` would be inventing a similarity that does not exist — they are
 * operated differently and a wrong pick between them is a wrong action, not a near miss.
 */
function scoreRole(stored: ElementFingerprint, live: ElementFingerprint): SignalScore {
  return { score: stored.role === live.role ? 1 : 0, applicable: true };
}

/**
 * Accessible name: exact on the hash, then graded on the redacted text.
 *
 * The hash is the fast path and the only one that matters when nothing changed. When it fails,
 * grading the redacted forms is what separates a rename ("Approve" → "Approve order", which
 * should still resolve on the strength of the other signals) from a different control entirely.
 *
 * Both sides unnamed is a match, not an absence: two anonymous wrappers genuinely do agree.
 * One side named and the other not is a mismatch.
 */
function scoreAccessibleName(stored: ElementFingerprint, live: ElementFingerprint): SignalScore {
  if (stored.accessibleNameHash === live.accessibleNameHash) {
    return { score: 1, applicable: true };
  }
  return {
    score: textSimilarity(stored.accessibleNameRedacted, live.accessibleNameRedacted),
    applicable: true,
  };
}

/**
 * Stable attributes: the fraction of the stored element's claims the live one still honours.
 *
 * Inapplicable when neither side carries any — the common case, and the reason applicability
 * exists at all. When the stored side has none but the live side has gained one, that is also
 * inapplicable rather than a mismatch: the page adding a test id is not evidence against
 * identity, and penalising it would make an application harder to resolve the moment its team
 * started adding test hooks.
 */
function scoreStableAttributes(stored: ElementFingerprint, live: ElementFingerprint): SignalScore {
  const names = Object.keys(stored.stableAttributes);
  if (names.length === 0) return { score: 0, applicable: false };

  let matched = 0;
  for (const name of names) {
    if (stored.stableAttributes[name] === live.stableAttributes[name]) matched += 1;
  }

  return { score: matched / names.length, applicable: true };
}

/**
 * Ordinal: decays with distance rather than falling to zero.
 *
 * A row that moved from position 3 to position 4 is almost certainly the same row; one that
 * moved from 3 to 40 probably is not. `1 / (1 + distance)` gives 1, 0.5, 0.33 … which drops
 * fast enough to break ties and slowly enough to survive an insertion.
 */
function scoreOrdinal(stored: ElementFingerprint, live: ElementFingerprint): SignalScore {
  const distance = Math.abs(stored.ordinal - live.ordinal);
  return { score: 1 / (1 + distance), applicable: true };
}

/** Text shingle: a digest, so binary. Weakest signal; a small vote either way. */
function scoreTextShingle(stored: ElementFingerprint, live: ElementFingerprint): SignalScore {
  return { score: stored.textShingleHash === live.textShingleHash ? 1 : 0, applicable: true };
}

/**
 * Geometry: inapplicable when neither side has any.
 *
 * The indexer runs headless and happy-dom does no layout, so zero-area boxes are routine.
 * Scoring them as a perfect match would hand out 0.05 of free confidence to every candidate
 * equally, which is noise; scoring them as a mismatch would penalise every element uniformly.
 * Dropping the signal is the only honest option.
 */
function scoreBbox(stored: ElementFingerprint, live: ElementFingerprint): SignalScore {
  const storedEmpty = stored.bbox.width === 0 && stored.bbox.height === 0;
  const liveEmpty = live.bbox.width === 0 && live.bbox.height === 0;
  if (storedEmpty && liveEmpty) return { score: 0, applicable: false };

  return { score: bboxSimilarity(stored.bbox, live.bbox), applicable: true };
}

/**
 * Word-level Dice coefficient over two redacted strings, in [0, 1].
 *
 * Dice rather than edit distance because the interesting comparisons are between short phrases
 * where word overlap is what matters: "Approve" against "Approve order" scores 0.67, while
 * "Approve" against "Reject" scores 0. Character-level distance would rank "Approve" and
 * "Approves" almost identically to "Approve" and "Reject", which is the wrong shape entirely.
 *
 * Two empty strings score 1 — both unnamed is agreement. One empty scores 0.
 */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;

  const wordsA = tokenize(a);
  const wordsB = tokenize(b);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  const remaining = new Map<string, number>();
  for (const word of wordsB) {
    remaining.set(word, (remaining.get(word) ?? 0) + 1);
  }

  let shared = 0;
  for (const word of wordsA) {
    const count = remaining.get(word) ?? 0;
    if (count > 0) {
      shared += 1;
      remaining.set(word, count - 1);
    }
  }

  return (2 * shared) / (wordsA.length + wordsB.length);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9[\]]+/i)
    .filter((word) => word !== '');
}
