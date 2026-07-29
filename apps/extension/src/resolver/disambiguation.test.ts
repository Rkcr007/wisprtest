import type { ResolutionCandidate, ResolutionResult } from 'protocol';
import { describe, expect, it } from 'vitest';

import { DEFAULT_RESOLVER_CONFIG } from './config.js';
import { buildDisambiguation, chooseByOrdinal, parseOrdinal } from './disambiguation.js';

/**
 * Disambiguation by spoken ordinal.
 *
 * The interesting half is what `parseOrdinal` *rejects*. A tester who is offered three options and
 * then says "approve order two" is issuing a command, not answering the question, and treating
 * that as a pick would fire an action on whichever element happened to be second. So the parser
 * only accepts an utterance that is nothing but an ordinal, and everything else falls through to
 * ordinary resolution.
 */

const STATE = 'a'.repeat(64);

function candidate(key: string, id: string, confidence: number): ResolutionCandidate {
  return {
    elementId: id,
    elementKey: key,
    label: key.split('.').at(-1) ?? key,
    confidence,
    signalScores: { embedding: confidence },
  };
}

const AMBIGUOUS: ResolutionResult = {
  outcome: 'ambiguous',
  tier: 'T2',
  latencyMs: 12,
  candidates: [
    candidate('orders.orders.approve', '11111111-1111-4111-8111-111111111111', 0.5),
    candidate('orders.orders.hold', '22222222-2222-4222-8222-222222222222', 0.48),
    candidate('orders.orders.reject', '33333333-3333-4333-8333-333333333333', 0.4),
    candidate('orders.orders.export', '44444444-4444-4444-8444-444444444444', 0.3),
  ],
};

describe('building the list', () => {
  it('numbers the ranked candidates from one', () => {
    const open = buildDisambiguation('put this aside', STATE, AMBIGUOUS, DEFAULT_RESOLVER_CONFIG);

    expect(open?.choices.map((choice) => choice.ordinal)).toEqual([1, 2, 3]);
    expect(open?.choices[0]?.candidate.elementKey).toBe('orders.orders.approve');
    expect(open?.tier).toBe('T2');
    expect(open?.stateFingerprint).toBe(STATE);
  });

  it('offers at most three, because that is what a tester can answer by speaking', () => {
    const open = buildDisambiguation('put this aside', STATE, AMBIGUOUS, DEFAULT_RESOLVER_CONFIG);

    expect(open?.choices).toHaveLength(3);
  });

  it('offers nothing when there is nothing to choose between', () => {
    const notFound: ResolutionResult = {
      outcome: 'not_found',
      tier: 'T2',
      latencyMs: 8,
      candidates: [],
    };

    // A different message for the HUD — "nothing here matched" — not an empty list of options.
    expect(buildDisambiguation('x', STATE, notFound, DEFAULT_RESOLVER_CONFIG)).toBeNull();
  });

  it('offers nothing for a result that already named an element', () => {
    const resolved: ResolutionResult = {
      outcome: 'resolved',
      elementId: '11111111-1111-4111-8111-111111111111',
      elementKey: 'orders.orders.approve',
      confidence: 0.95,
      tier: 'T0',
      latencyMs: 2,
      candidates: [],
    };

    expect(buildDisambiguation('approve', STATE, resolved, DEFAULT_RESOLVER_CONFIG)).toBeNull();
  });
});

describe('reading a spoken ordinal', () => {
  it.each([
    ['one', 1],
    ['One.', 1],
    ['the first', 1],
    ['two', 2],
    ['the second one', 2],
    ['number two', 2],
    ['option 2', 2],
    ['three', 3],
    ['the third', 3],
  ])('reads %j as %i', (utterance, expected) => {
    expect(parseOrdinal(utterance, 3)).toBe(expected);
  });

  it('reads "to" as two, because that is what ASR hears', () => {
    // Not a guess about English: a tester says "two" and a streaming recogniser writes "to" often
    // enough that treating it as a miss would make the feature feel broken.
    expect(parseOrdinal('to', 3)).toBe(2);
  });

  it.each(['approve order two', 'open the second orders page please', 'two three', 'pending', ''])(
    'does not read %j as a pick',
    (utterance) => {
      expect(parseOrdinal(utterance, 3)).toBeNull();
    },
  );

  it('rejects an ordinal past the end of the list', () => {
    expect(parseOrdinal('three', 2)).toBeNull();
  });
});

describe('choosing', () => {
  it('returns the candidate at the spoken position', () => {
    const open = buildDisambiguation('put this aside', STATE, AMBIGUOUS, DEFAULT_RESOLVER_CONFIG);
    if (open === null) throw new Error('expected a disambiguation');

    expect(chooseByOrdinal(open, 2)?.elementKey).toBe('orders.orders.hold');
  });

  it('returns nothing for a position that was not offered', () => {
    const open = buildDisambiguation('put this aside', STATE, AMBIGUOUS, DEFAULT_RESOLVER_CONFIG);
    if (open === null) throw new Error('expected a disambiguation');

    expect(chooseByOrdinal(open, 4)).toBeNull();
  });
});
