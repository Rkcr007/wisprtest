import type { ResolutionCandidate, ResolutionResult, Tier } from 'protocol';

import type { ResolverConfig } from './config.js';
import { normalizePhrase } from './normalize.js';

/**
 * Disambiguation by spoken ordinal — "one, two, or three".
 *
 * When no tier could name an element, the tester chooses instead of the resolver guessing. They are
 * already talking, so the choice is spoken: the HUD numbers the ranked candidates and the tester
 * says "two". That is the whole interaction, and it is why `disambiguationLimit` is three — a list
 * long enough to need re-reading is one a tester answers with a mouse.
 *
 * ## Why a correction is written back
 *
 * Per the phase: "a correction is the highest-quality training signal available." The model can be
 * wrong; a tester pointing at the element they meant cannot. So a pick is persisted as an alias
 * with `source: 'manual'`, and the same phrasing is a T0 hit for everyone on the tenant afterwards.
 *
 * ## What this module is not
 *
 * It holds no DOM and renders nothing. It turns a `ResolutionResult` into a numbered list, reads an
 * ordinal out of an utterance, and reports which candidate was chosen. The HUD renders the list;
 * the content script feeds it speech. Keeping it that way is what makes it testable without a page.
 */

export interface DisambiguationChoice {
  /** One-based, as spoken. `1` is "one" / "the first". */
  readonly ordinal: number;
  readonly candidate: ResolutionCandidate;
}

export interface Disambiguation {
  /** The phrase that failed to resolve, redacted — what an accepted pick is learned as. */
  readonly phrase: string;
  /** The screen the choice is being made on; scopes the alias to it. */
  readonly stateFingerprint: string;
  /** The tier that gave up and asked. Carried onto the pick so the session step stays truthful. */
  readonly tier: Tier;
  readonly choices: readonly DisambiguationChoice[];
}

/**
 * Build a numbered list from an ambiguous result, or null when there is nothing to choose from.
 *
 * `resolved` never reaches here — the resolver named an element — and a `not_found` with no
 * candidates has nothing to offer, which is a different message for the HUD to show ("nothing on
 * this screen matched") rather than an empty list of options.
 */
export function buildDisambiguation(
  phrase: string,
  stateFingerprint: string,
  result: ResolutionResult,
  config: ResolverConfig,
): Disambiguation | null {
  if (result.outcome === 'resolved') return null;
  if (result.candidates.length < 2) return null;

  return {
    phrase,
    stateFingerprint,
    tier: result.tier,
    choices: result.candidates
      .slice(0, config.disambiguationLimit)
      .map((candidate, index) => ({ ordinal: index + 1, candidate })),
  };
}

/** The words a tester actually says for the first three positions. */
const ORDINAL_WORDS: ReadonlyMap<string, number> = new Map([
  ['1', 1],
  ['one', 1],
  ['first', 1],
  ['2', 2],
  ['two', 2],
  ['to', 2], // ASR routinely hears "two" as "to"; both are the second option in this context.
  ['too', 2],
  ['second', 2],
  ['3', 3],
  ['three', 3],
  ['third', 3],
]);

/** Filler an ordinal is commonly wrapped in: "the first one", "number two", "option 3". */
const ORDINAL_FILLER: ReadonlySet<string> = new Set([
  'the',
  'number',
  'option',
  'choice',
  'item',
  'one', // "the first one" — trailing "one" is a noun here, not the ordinal.
]);

/**
 * Read a spoken ordinal out of an utterance, or null if it names no position.
 *
 * Deliberately strict: only an utterance that is *nothing but* an ordinal counts. "two" picks the
 * second candidate; "approve order two" is a fresh command that happens to contain a number, and
 * treating it as a pick would hijack the next thing the tester says. When in doubt, this returns
 * null and the utterance is resolved normally.
 */
export function parseOrdinal(utterance: string, limit: number): number | null {
  const words = normalizePhrase(utterance).split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 3) return null;

  let found: number | null = null;
  for (const word of words) {
    const ordinal = ORDINAL_WORDS.get(word);
    // A leading "one" is the ordinal; a trailing one is the noun in "the first one".
    if (ordinal !== undefined && !(word === 'one' && found !== null)) {
      if (found !== null) return null; // two ordinals is not a pick, it is a sentence
      found = ordinal;
      continue;
    }
    if (!ORDINAL_FILLER.has(word)) return null;
  }

  if (found === null || found > limit) return null;
  return found;
}

/** The candidate a spoken ordinal names, or null when it names none of the offered choices. */
export function chooseByOrdinal(
  disambiguation: Disambiguation,
  ordinal: number,
): ResolutionCandidate | null {
  return disambiguation.choices.find((choice) => choice.ordinal === ordinal)?.candidate ?? null;
}
