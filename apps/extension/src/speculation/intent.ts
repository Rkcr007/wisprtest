import { defaultRedactor, type Redactor } from 'fingerprint';
import type { ActionVerb, MemorySnapshot, QueryConstraint } from 'protocol';

import { normalizePhrase } from '../resolver/normalize.js';

/**
 * The intent parser — utterance → `{ verb, targetPhrase, constraints }`, with no model in the loop.
 *
 * docs/BUILD-PLAN.md Phase 10 is explicit: "Rule-based over the learned vocabulary in the memory
 * snapshot; no LLM in this phase." So this is a deterministic grammar, not a classifier. It reads
 * a leading verb from a closed, overridable lexicon, then pulls the qualifiers the scored resolver
 * can act on — an ordinal ("the second one"), a landmark scope ("in the sidebar"), a literal value
 * ("filter by pending") — and hands the rest to the resolver as the target phrase.
 *
 * ## Where the vocabulary comes in
 *
 * Two decisions lean on {@link IntentVocabulary}, built from the snapshot, so they are learned per
 * application rather than guessed:
 *
 * - **Verb inference when none is spoken.** "orders" with no verb is a navigation if "Orders" is a
 *   screen the app actually has; otherwise it is a control to click. That distinction is what keeps
 *   read-only navigation on the fast `R` path (see classify.ts) — and it comes from the nav graph,
 *   never from `if (app === …)`.
 * - **Landmark validation.** "in the orders region" is a `within` constraint only when the app
 *   really has that landmark; a generic landmark word (sidebar, header, dialog) is always allowed.
 *
 * ## What it does not do
 *
 * It does not resolve — that is the resolver's job, fed `targetPhrase`. It does not disambiguate,
 * and it does not invent verbs: an utterance whose action is not in {@link ActionVerb} comes back
 * as the closest supported verb or `click`, never as something the executor cannot dispatch.
 *
 * Everything it emits as text has passed through a {@link Redactor} first: the utterance is the
 * tester's own speech, but a value they read aloud off the screen ("filter by acme@corp.com") could
 * carry the application's content, and CLAUDE.md § "PII rule" keeps that out of a stored intent.
 */

export interface ParsedIntent {
  readonly verb: ActionVerb;
  /** Redacted phrase naming the target the resolver should look up. */
  readonly targetPhrase: string;
  readonly constraints: readonly QueryConstraint[];
  /**
   * The value to type/select/filter, *before* redaction — the actual characters the executor
   * dispatches. In-memory only, never logged or persisted: the redacted form is what reaches the
   * `ScopedQuery` constraint and the session step. Undefined for verbs that carry no value.
   *
   * It is the normalised value ASR produced, not a reconstruction of exact casing and punctuation,
   * which voice input cannot recover; that limit is honest, not a stub.
   */
  readonly rawValue?: string;
}

/** Learned words, extracted from a snapshot, that steer otherwise-ambiguous parses. */
export interface IntentVocabulary {
  /** Normalised phrases that denote a place to go — screen labels and nav-edge triggers. */
  readonly navTargets: ReadonlySet<string>;
  /** Normalised landmark names the application actually exposes. */
  readonly landmarks: ReadonlySet<string>;
}

export const EMPTY_VOCABULARY: IntentVocabulary = {
  navTargets: new Set(),
  landmarks: new Set(),
};

/**
 * The verb lexicon: normalised trigger phrase → verb. Longest match at the start of the utterance
 * wins, so "go back" beats "go" and "show only" beats "show". Overridable, per the house rule that
 * vocabulary is data, not constants scattered through code — a locale pack is a different table.
 *
 * The mapping reflects the reversibility split classify.ts enforces: "approve"/"submit"/"delete"
 * are `click` (committing), while "open"/"go to"/"show" are `navigate` (reversible). A tester who
 * says "approve" gets a gated click; one who says "open orders" gets fast navigation.
 */
export const DEFAULT_VERB_LEXICON: ReadonlyMap<string, ActionVerb> = new Map([
  ['navigate to', 'navigate'],
  ['go to', 'navigate'],
  ['take me to', 'navigate'],
  ['open', 'navigate'],
  ['show me', 'navigate'],
  ['show', 'navigate'],
  ['view', 'navigate'],
  ['visit', 'navigate'],
  ['go back', 'back'],
  ['back', 'back'],
  ['click', 'click'],
  ['press', 'click'],
  ['tap', 'click'],
  ['approve', 'click'],
  ['submit', 'click'],
  ['confirm', 'click'],
  ['accept', 'click'],
  ['delete', 'click'],
  ['remove', 'click'],
  ['save', 'click'],
  ['type', 'type'],
  ['enter', 'type'],
  ['fill in', 'type'],
  ['fill', 'type'],
  ['input', 'type'],
  ['write', 'type'],
  ['focus on', 'focus'],
  ['focus', 'focus'],
  ['scroll', 'scroll'],
  ['show only', 'filter'],
  ['only show', 'filter'],
  ['filter by', 'filter'],
  ['filter', 'filter'],
  ['only', 'filter'],
  ['make sure', 'check'],
  ['verify', 'check'],
  ['assert', 'check'],
  ['ensure', 'check'],
  ['check', 'check'],
  ['select', 'select'],
  ['choose', 'select'],
  ['pick', 'select'],
]);

/** Spoken ordinals → one-based index, as the `QueryConstraint` ordinal wants them. */
const ORDINAL_WORDS: ReadonlyMap<string, number> = new Map([
  ['first', 1],
  ['second', 2],
  ['third', 3],
  ['fourth', 4],
  ['fifth', 5],
  ['sixth', 6],
  ['seventh', 7],
  ['eighth', 8],
  ['ninth', 9],
  ['tenth', 10],
]);

/** Spoken cardinals → number, for the "number N" form where N is said as a count, not an ordinal. */
const CARDINAL_WORDS: ReadonlyMap<string, number> = new Map([
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
  ['ten', 10],
]);

/** Landmark words allowed without snapshot confirmation — every application has these regions. */
const GENERIC_LANDMARKS: ReadonlySet<string> = new Set([
  'sidebar',
  'header',
  'footer',
  'nav',
  'navigation',
  'main',
  'dialog',
  'modal',
  'toolbar',
  'banner',
  'menu',
  'form',
]);

/** Directions the scroll verb understands, carried as a value constraint for the executor. */
const SCROLL_DIRECTIONS: ReadonlySet<string> = new Set(['up', 'down', 'top', 'bottom']);

/** Prepositions that separate a typed/selected/filtered value from the control it targets. */
const VALUE_PREPOSITIONS: ReadonlySet<string> = new Set(['by', 'with', 'for', 'as', 'to']);
/** Prepositions that introduce the target control after a value ("type acme into the search"). */
const TARGET_PREPOSITIONS: ReadonlySet<string> = new Set(['into', 'in', 'on']);
const ARTICLES: ReadonlySet<string> = new Set(['the', 'a', 'an']);

export interface IntentParserOptions {
  readonly vocabulary?: IntentVocabulary;
  readonly lexicon?: ReadonlyMap<string, ActionVerb>;
  readonly redact?: Redactor;
}

export interface IntentParser {
  parse(utterance: string): ParsedIntent;
}

/** Build the learned vocabulary the parser leans on from a memory snapshot. */
export function buildIntentVocabulary(snapshot: MemorySnapshot): IntentVocabulary {
  const navTargets = new Set<string>();
  for (const screen of snapshot.screens) navTargets.add(normalizePhrase(screen.label));

  // A nav edge's trigger is the control a tester clicks to move screens — "open orders" names it.
  const nameById = new Map<string, string>();
  for (const element of snapshot.elements) {
    nameById.set(element.id, element.fingerprint.accessibleNameRedacted);
  }
  for (const edge of snapshot.navEdges) {
    const name = nameById.get(edge.triggerElementId);
    if (name !== undefined && name !== '') navTargets.add(normalizePhrase(name));
  }

  const landmarks = new Set<string>();
  for (const element of snapshot.elements) {
    for (const entry of element.fingerprint.landmarkPath) {
      const normalized = normalizePhrase(entry);
      if (normalized === '') continue;
      landmarks.add(normalized);
      // Ancestry entries look like "region:orders"; the name after the colon is what is spoken.
      const colon = entry.indexOf(':');
      if (colon >= 0) landmarks.add(normalizePhrase(entry.slice(colon + 1)));
    }
  }

  return { navTargets, landmarks };
}

export function createIntentParser(options: IntentParserOptions = {}): IntentParser {
  const vocabulary = options.vocabulary ?? EMPTY_VOCABULARY;
  const lexicon = options.lexicon ?? DEFAULT_VERB_LEXICON;
  const redact = options.redact ?? defaultRedactor;

  // Trigger phrases sorted longest-first, so a longest-prefix match is a linear scan.
  const triggers = [...lexicon.keys()].sort((a, b) => b.length - a.length);

  function matchVerb(normalized: string): { verb: ActionVerb; rest: string } | null {
    for (const trigger of triggers) {
      const verb = lexicon.get(trigger);
      if (verb === undefined) continue;
      if (normalized === trigger) return { verb, rest: '' };
      if (normalized.startsWith(`${trigger} `)) {
        return { verb, rest: normalized.slice(trigger.length + 1) };
      }
    }
    return null;
  }

  function stripLeadingArticle(words: string[]): string[] {
    const first = words[0];
    return first !== undefined && ARTICLES.has(first) ? words.slice(1) : words;
  }

  /** Pull an ordinal constraint out of the word list, returning the remaining words. */
  function takeOrdinal(words: string[]): { index: number | null; rest: string[] } {
    const out: string[] = [];
    let index: number | null = null;
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i];
      if (word === undefined) continue;

      const ordinal = ORDINAL_WORDS.get(word);
      if (index === null && ordinal !== undefined) {
        index = ordinal;
        continue;
      }
      // "number three" (cardinal, the natural form), "number 3", or "number third".
      const next = words[i + 1];
      if (index === null && word === 'number' && next !== undefined) {
        const asWord = CARDINAL_WORDS.get(next) ?? ORDINAL_WORDS.get(next);
        const asDigit = /^\d+$/.test(next) ? Number.parseInt(next, 10) : null;
        if (asWord !== undefined) {
          index = asWord;
          i += 1;
          continue;
        }
        if (asDigit !== null && asDigit >= 1) {
          index = asDigit;
          i += 1;
          continue;
        }
      }
      out.push(word);
    }
    return { index, rest: out };
  }

  /** Pull a `within` landmark constraint ("in the sidebar") out of the word list. */
  function takeWithin(words: string[]): { landmark: string | null; rest: string[] } {
    for (let i = 0; i < words.length - 1; i += 1) {
      if (words[i] !== 'in' && words[i] !== 'inside') continue;
      let j = i + 1;
      const article = words[j];
      if (article !== undefined && ARTICLES.has(article)) j += 1;
      const candidate = words[j];
      if (candidate === undefined) continue;
      if (GENERIC_LANDMARKS.has(candidate) || vocabulary.landmarks.has(candidate)) {
        // "the orders region" — take the region's own name where the app confirms it.
        const rest = [...words.slice(0, i), ...words.slice(j + 1)];
        return { landmark: candidate, rest };
      }
    }
    return { landmark: null, rest: words };
  }

  return {
    parse(utterance: string): ParsedIntent {
      const normalized = normalizePhrase(utterance);
      const matched = matchVerb(normalized);

      let verb: ActionVerb;
      let restWords: string[];
      if (matched !== null) {
        verb = matched.verb;
        restWords = stripLeadingArticle(matched.rest.split(' ').filter((w) => w !== ''));
      } else {
        // No verb word: a bare phrase. It is a navigation when the app has a screen or trigger by
        // that name, otherwise a control to click. This is where the learned nav vocabulary earns
        // its place — it is the only thing that can tell "orders" (a place) from "approve" (a act).
        verb = vocabulary.navTargets.has(normalized) ? 'navigate' : 'click';
        restWords = stripLeadingArticle(normalized.split(' ').filter((w) => w !== ''));
      }

      const constraints: QueryConstraint[] = [];

      const ordinal = takeOrdinal(restWords);
      restWords = ordinal.rest;
      if (ordinal.index !== null) constraints.push({ kind: 'ordinal', index: ordinal.index });

      const within = takeWithin(restWords);
      restWords = within.rest;
      if (within.landmark !== null) {
        constraints.push({ kind: 'within', landmark: redact(within.landmark) });
      }

      let targetPhrase: string;
      let rawValue: string | undefined;

      if (verb === 'scroll') {
        // Scroll names a direction, not an element; the container is the executor's to choose.
        const direction = restWords.find((w) => SCROLL_DIRECTIONS.has(w)) ?? 'down';
        constraints.push({ kind: 'value', text: redact(direction) });
        targetPhrase = redact(direction);
        rawValue = direction;
      } else if (verb === 'type' || verb === 'filter' || verb === 'select') {
        const split = splitValueAndTarget(restWords);
        if (split.value !== '') constraints.push({ kind: 'value', text: redact(split.value) });
        // Resolve against the named control when there is one, else against the value itself — a
        // filter chip is often labelled with the value ("Pending"), so the value is a fair target.
        targetPhrase = redact(split.target !== '' ? split.target : split.value);
        rawValue = split.value;
      } else {
        targetPhrase = redact(restWords.join(' '));
      }

      return rawValue === undefined
        ? { verb, targetPhrase, constraints }
        : { verb, targetPhrase, constraints, rawValue };
    },
  };
}

/**
 * Split "acme into the search" → value "acme", target "search"; "by pending" → value "pending".
 *
 * The first value preposition, if the phrase leads with one, is dropped ("filter **by** pending").
 * A target preposition splits value from control ("type acme **into** the search box").
 */
function splitValueAndTarget(words: string[]): { value: string; target: string } {
  let value = words;
  const lead = value[0];
  if (lead !== undefined && VALUE_PREPOSITIONS.has(lead)) value = value.slice(1);

  const splitAt = value.findIndex((w) => TARGET_PREPOSITIONS.has(w));
  if (splitAt >= 0) {
    let targetWords = value.slice(splitAt + 1);
    const article = targetWords[0];
    if (article !== undefined && ARTICLES.has(article)) targetWords = targetWords.slice(1);
    return { value: value.slice(0, splitAt).join(' '), target: targetWords.join(' ') };
  }
  return { value: value.join(' '), target: '' };
}
