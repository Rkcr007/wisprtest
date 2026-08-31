import { normalizePhrase } from '../resolver/normalize.js';

/**
 * The reserved voice lexicon — the words that mean something to WisprTest rather than to the
 * application under test.
 *
 * A tester working by voice needs to interrupt the tool in the medium they are already in. That
 * is what these phrases are for, and [ADR 0017](../../../../docs/adr/0017-reserved-voice-lexicon-and-command-collisions.md)
 * is the rule that makes them safe to reserve:
 *
 * > A reserved phrase is recognised only as a complete utterance carrying no verb. Prefixing any
 * > verb from the runtime lexicon reaches the application instead.
 *
 * ```
 * "stop"            → halt
 * "stop stop"       → halt
 * "click stop"      → the application's Stop button
 * "stop the import" → a command; not a bare match
 * ```
 *
 * ## Why the collision needs a rule at all
 *
 * The words a person reaches for to interrupt a machine are the words enterprise applications
 * print on buttons. "Stop" is on every job runner; "Cancel" is in every dialog. `intent.ts` already
 * maps `confirm`, `accept`, `approve` and `save` to `click` for that reason — they are labels.
 *
 * Blanket priority for the reserved reading would also invert CLAUDE.md § "What is generic vs what
 * is per-application": this table is generic, written once for every customer, while an element
 * label is learned per application by the indexer. Letting the generic table win everywhere means
 * a hardcoded list silently overriding learned knowledge about one customer's screen.
 *
 * The bare-utterance rule avoids both. It is decided lexically — one `normalizePhrase` and one map
 * lookup, no resolution, no candidate set — so a reserved word means the same thing on every
 * screen, and the application's own control is one verb away.
 *
 * ## The asymmetry that makes a lexical rule honest here
 *
 * `seed/intent.ts` reasons the same way, and the arithmetic is the same. Halting when the tester
 * meant the button costs one repeated utterance and changes nothing on the page. Clicking the
 * button when the tester meant to halt dismisses a dialog — a state change made by a runtime that
 * had just been told to stop. Neither mistake is free, but only one of them touches the
 * application, so the rule leans that way deliberately.
 *
 * ## What this module is not
 *
 * It does not act. It reads an utterance and names an intent; the speculation controller decides
 * what that intent does, and the controller is where the taxonomy is enforced. It holds no DOM,
 * makes no network call, and knows nothing about any particular application — per ADR 0017 there
 * is deliberately no per-application override, because an application must not be able to redefine
 * what "stop" means to the tool testing it.
 */

/**
 * The intents a reserved phrase can name.
 *
 * Closed, and containing only what has a handler today. The Voice Correction & Safety Track adds
 * `reject_last`, `undo_last` and `replay_last` in the slices that implement their effects — a
 * recognised word that does nothing is the kind of placeholder CLAUDE.md rule 1 forbids, and it
 * would be worse than not recognising it at all: the tester would believe they had been heard.
 */
export type ReservedIntent = 'halt';

/**
 * Phrase → intent. Normalised at construction and matched against the whole utterance.
 *
 * Each entry is a word taken away from the application's namespace, so the list is short by
 * design and every entry earns its place:
 *
 * - `stop`, `stop stop` — what a person says to a machine that is doing the wrong thing. The
 *   repetition is the urgent form, and `normalizePhrase` collapses "Stop, stop!" onto it.
 * - `wait`, `hold on` — the same instinct, phrased as a pause. Rarely a control label.
 * - `cancel`, `cancel that` — the most common label of the five, and reserved anyway: a tester
 *   who says a bare "cancel" while a committing action is staged means the staged action, not the
 *   dialog behind it.
 * - `never mind`, `nevermind` — abandoning the utterance rather than the application's state.
 *
 * "Abort" is deliberately absent. It is jargon, so it is reached for rarely, and the applications
 * where it *is* said — CI, job runners, batch tooling — are the ones where it is also a button and
 * where halting the tool and aborting the job are catastrophically different. The rule would
 * handle it safely; the benefit does not justify taking the word.
 */
export const DEFAULT_RESERVED_LEXICON: ReadonlyMap<string, ReservedIntent> = new Map([
  ['stop', 'halt'],
  ['stop stop', 'halt'],
  ['wait', 'halt'],
  ['hold on', 'halt'],
  ['cancel', 'halt'],
  ['cancel that', 'halt'],
  ['never mind', 'halt'],
  ['nevermind', 'halt'],
]);

export interface ReservedMatcher {
  /**
   * The reserved intent this utterance names, or null.
   *
   * Null for anything that is not a whole-utterance match, which includes every utterance that
   * merely *contains* a reserved word. That is the bare-utterance rule, and it is why the check
   * is safe to run ahead of the parser on every final transcript.
   */
  match(utterance: string): ReservedIntent | null;
}

export interface ReservedMatcherOptions {
  /**
   * Overridable, as every lexicon in this codebase is — a locale pack is a different table, not an
   * edit to this one. There is no per-application override by design; see the module doc.
   */
  readonly lexicon?: ReadonlyMap<string, ReservedIntent>;
}

export function createReservedMatcher(options: ReservedMatcherOptions = {}): ReservedMatcher {
  const source = options.lexicon ?? DEFAULT_RESERVED_LEXICON;

  // Normalised once at construction, so `match` is a single lookup rather than a scan. A caller
  // supplying its own lexicon gets the same treatment as the default one.
  const lexicon = new Map<string, ReservedIntent>();
  for (const [phrase, intent] of source) {
    const normalized = normalizePhrase(phrase);
    if (normalized !== '') lexicon.set(normalized, intent);
  }

  return {
    match(utterance: string): ReservedIntent | null {
      const normalized = normalizePhrase(utterance);
      if (normalized === '') return null;
      return lexicon.get(normalized) ?? null;
    },
  };
}
