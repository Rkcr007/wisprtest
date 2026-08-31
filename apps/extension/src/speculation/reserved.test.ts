import { describe, expect, it } from 'vitest';

import { createIntentParser } from './intent.js';
import { createReservedMatcher, DEFAULT_RESERVED_LEXICON } from './reserved.js';

/**
 * The bare-utterance rule from ADR 0017, and the collision it exists to arbitrate.
 *
 * The properties worth pinning are the two that make the rule safe to ship: a reserved phrase is
 * recognised only as a *whole* utterance, and prefixing a verb hands the same word back to the
 * application. Everything else about this module is a map lookup.
 */

const matcher = createReservedMatcher();

describe('a bare reserved phrase', () => {
  it.each([...DEFAULT_RESERVED_LEXICON.keys()])('recognises %j on its own', (phrase) => {
    expect(matcher.match(phrase)).toBe('halt');
  });

  it('normalises case, punctuation and repetition the way a tester speaks', () => {
    // "Stop, stop!" is the urgent form, and ASR punctuates it. All three are one utterance.
    expect(matcher.match('Stop!')).toBe('halt');
    expect(matcher.match('  stop  ')).toBe('halt');
    expect(matcher.match('Stop, stop!')).toBe('halt');
    expect(matcher.match('Never mind.')).toBe('halt');
  });

  it('is null for an empty or whitespace-only utterance', () => {
    expect(matcher.match('')).toBeNull();
    expect(matcher.match('   ')).toBeNull();
  });
});

describe('an utterance that merely contains a reserved word', () => {
  // This is the whole rule. An utterance is reserved or it is a command, and length decides —
  // never a resolution against whatever happens to be on the screen.
  it.each([
    'stop the import job',
    'click stop',
    'press stop',
    'cancel the order',
    'click cancel',
    'wait for the upload',
    'stop and think',
  ])('leaves %j to the application', (utterance) => {
    expect(matcher.match(utterance)).toBeNull();
  });
});

describe('the verb-prefixed escape hatch', () => {
  const parser = createIntentParser();

  it.each([
    ['click stop', 'stop'],
    ['press stop', 'stop'],
    ['click cancel', 'cancel'],
    ['tap wait', 'wait'],
  ])('%j reaches the application as a click on %j', (utterance, target) => {
    // The reserved reading declines it, and the intent parser then reads it as an ordinary
    // command. Both halves have to hold, or ADR 0017's escape hatch is not actually reachable.
    expect(matcher.match(utterance)).toBeNull();

    const parsed = parser.parse(utterance);
    expect(parsed.verb).toBe('click');
    expect(parsed.targetPhrase).toBe(target);
  });
});

describe('the lexicon itself', () => {
  it('takes no word that is not deliberate', () => {
    // "Abort" is excluded on purpose: it is a button in CI and job-runner applications, and there
    // halting the tool and aborting the job are different actions. See ADR 0017.
    expect(matcher.match('abort')).toBeNull();
  });

  it('is overridable, and normalises whatever a caller supplies', () => {
    const custom = createReservedMatcher({ lexicon: new Map([['  ARRÊTE  ', 'halt']]) });

    expect(custom.match('arrête')).toBe('halt');
    // Supplying a lexicon replaces the default rather than extending it — a locale pack is a
    // different table, not an edit to this one.
    expect(custom.match('stop')).toBeNull();
  });

  it('ignores an entry that normalises to nothing', () => {
    const custom = createReservedMatcher({ lexicon: new Map([['!!!', 'halt']]) });

    expect(custom.match('!!!')).toBeNull();
    expect(custom.match('')).toBeNull();
  });
});
