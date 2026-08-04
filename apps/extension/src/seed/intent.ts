import { normalizePhrase } from '../resolver/normalize.js';

/**
 * Telling "I need a pending order for Acme" apart from "click create".
 *
 * Seeding is action class **S**, and CLAUDE.md § "Reversibility taxonomy" gives it its own row for
 * a reason: it is never speculative and never silent. So it does not enter through the runtime verb
 * set at all. `speculation/classify.ts` says as much — "S is produced by no verb here: seeding is
 * its own flow, reached through a preview, not through the runtime verb set" — and adding a `seed`
 * verb to {@link ActionVerb} would have put a writing action on the same road as a click, one
 * classifier bug away from being dispatched by the executor.
 *
 * This module is the fork instead. It reads an utterance and answers one question: is the tester
 * asking for a *precondition to exist*, or telling us to *operate a control*? Lexically, with no
 * network call and no resolution, because it runs on every hypothesis and the hot path is measured
 * in milliseconds.
 *
 * ## Why the triggers come in two tiers
 *
 * Some openings cannot be anything else. No button in any application is labelled "I need" or
 * "give me" — those are how a person asks for data, and they route to the seed flow on sight.
 *
 * "Create", "add" and "new" are different: they are the most common button labels there are. An
 * utterance opening with one of those is a seed request only when the rest of it describes a
 * *record* rather than naming a control — a qualifier like "for Acme", "with three line items",
 * "that is overdue". A control label does not carry those; a record description almost always does.
 *
 * The cost of each mistake is deliberately asymmetric. Routing a click to the seed flow costs a
 * preview card the tester dismisses, and writes nothing — `/v1/seed/plan` is a read. Routing a seed
 * request to the runtime costs a phrase that resolves to no element, which stages a reticle and
 * also does nothing. Neither direction can execute the wrong thing, which is what makes a lexical
 * rule an honest one here rather than a guess with teeth.
 *
 * ## What it does not do
 *
 * It does not identify the entity, the fields or the constraints. That is the composer's parser,
 * which matches against *this application's* learned schemas and enum vocabularies — per CLAUDE.md
 * § "generic vs per-application", entity knowledge is learned per app and must never appear as a
 * table in the extension. The utterance travels to `/v1/seed/plan` unchanged
 * ({@link SeedPlanRequest}: "passed through to the composer's parser unchanged") and the composer
 * answers with a plan, a conflict, or a refusal naming the fields it could not fill.
 */

/**
 * Openings that can only be a request for data.
 *
 * Longest match wins, so "i need" is tried before "i", and the list is ordered by length at
 * construction rather than by hand. Overridable for the same reason every other lexicon here is:
 * a locale pack is a different table, not an edit to this one.
 */
export const DEFAULT_UNAMBIGUOUS_TRIGGERS: readonly string[] = [
  'i need',
  'i want',
  'we need',
  'i need to have',
  'give me',
  'get me',
  'make me',
  'i require',
  'seed',
  'seed me',
  'generate',
  'generate me',
];

/**
 * Openings that are also plausible control labels.
 *
 * Each of these appears on a button in most applications, so on its own it is a click. It becomes a
 * seed request only alongside a qualifier — see {@link QUALIFIER_MARKERS}.
 */
export const DEFAULT_AMBIGUOUS_TRIGGERS: readonly string[] = [
  'create',
  'create a',
  'add',
  'add a',
  'new',
  'make',
  'set up',
];

/**
 * Words that describe a record rather than name a control.
 *
 * A button reads "Create order". A precondition reads "create an order **for** Acme", "an order
 * **with** three line items", "an invoice **that** is overdue". These are the joints where a noun
 * phrase acquires properties, and a control label has none.
 */
const QUALIFIER_MARKERS: ReadonlySet<string> = new Set([
  'for',
  'with',
  'that',
  'thats',
  'whose',
  'having',
  'containing',
  'worth',
  'belonging',
  'assigned',
]);

/** Spoken counts. "three line items" is a cardinality constraint, and a button never has one. */
const CARDINAL_WORDS: ReadonlySet<string> = new Set([
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'several',
  'a few',
]);

export interface SeedIntentLexicon {
  readonly unambiguous: readonly string[];
  readonly ambiguous: readonly string[];
}

export const DEFAULT_SEED_LEXICON: SeedIntentLexicon = {
  unambiguous: DEFAULT_UNAMBIGUOUS_TRIGGERS,
  ambiguous: DEFAULT_AMBIGUOUS_TRIGGERS,
};

/**
 * What the detector concluded.
 *
 * `subject` is the utterance with its trigger removed — "a pending order for acme" from "I need a
 * pending order for Acme". It is carried for the HUD's own use while a plan is in flight, so the
 * card can say what is being composed before the composer has answered. It is **not** what is sent
 * to the gateway: the composer receives the whole utterance, because the trigger is part of how a
 * constraint parser reads a sentence.
 */
export interface SeedIntent {
  readonly isSeed: boolean;
  /** The trigger that matched, normalised. Null when nothing did. */
  readonly trigger: string | null;
  /** The remainder after the trigger, normalised. Empty when the trigger was the whole utterance. */
  readonly subject: string;
  /** Which tier of the lexicon matched, and — for `ambiguous` — that a qualifier was found too. */
  readonly certainty: 'unambiguous' | 'qualified' | 'none';
}

const NOT_SEED: SeedIntent = { isSeed: false, trigger: null, subject: '', certainty: 'none' };

export interface SeedIntentDetector {
  detect(utterance: string): SeedIntent;
}

export interface SeedIntentDetectorOptions {
  readonly lexicon?: SeedIntentLexicon;
}

/** Whether a remainder describes a record: it names a property, or it counts something. */
function hasQualifier(subject: string): boolean {
  const words = subject.split(' ');
  for (const word of words) {
    if (QUALIFIER_MARKERS.has(word)) return true;
    if (CARDINAL_WORDS.has(word)) return true;
    // A digit is a count however it was transcribed: "3 line items", "with 3".
    if (/^\d+$/.test(word)) return true;
  }
  return false;
}

export function createSeedIntentDetector(
  options: SeedIntentDetectorOptions = {},
): SeedIntentDetector {
  const lexicon = options.lexicon ?? DEFAULT_SEED_LEXICON;

  // Normalised once at construction, and longest-first so a longest-prefix match is a linear scan —
  // the same shape the intent parser's verb lexicon uses, for the same reason.
  const byLength = (list: readonly string[]): readonly string[] =>
    [...list].map(normalizePhrase).sort((a, b) => b.length - a.length);

  const unambiguous = byLength(lexicon.unambiguous);
  const ambiguous = byLength(lexicon.ambiguous);

  function match(normalized: string, triggers: readonly string[]): string | null {
    for (const trigger of triggers) {
      if (normalized === trigger) return trigger;
      if (normalized.startsWith(`${trigger} `)) return trigger;
    }
    return null;
  }

  return {
    detect(utterance: string): SeedIntent {
      const normalized = normalizePhrase(utterance);
      if (normalized === '') return NOT_SEED;

      const certain = match(normalized, unambiguous);
      if (certain !== null) {
        return {
          isSeed: true,
          trigger: certain,
          subject: normalized.slice(certain.length).trim(),
          certainty: 'unambiguous',
        };
      }

      const maybe = match(normalized, ambiguous);
      if (maybe === null) return NOT_SEED;

      const subject = normalized.slice(maybe.length).trim();
      // "create" alone, or "create order", is a button. "create an order for acme" is a record.
      if (!hasQualifier(subject)) return NOT_SEED;

      return { isSeed: true, trigger: maybe, subject, certainty: 'qualified' };
    },
  };
}
