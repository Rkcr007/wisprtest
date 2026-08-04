import { describe, expect, it } from 'vitest';

import { createSeedIntentDetector } from './intent.js';

/**
 * The fork: a request for data, or an instruction to operate a control.
 *
 * The interesting cases are the near misses in both directions, because both directions have a
 * cost. A seed request read as a click resolves to nothing and the tester's precondition never
 * arrives; a click read as a seed request pops a card they have to dismiss. Neither can execute the
 * wrong thing — `/v1/seed/plan` writes nothing and an unresolvable phrase stages a reticle — but
 * both are wrong, so the boundary is pinned down here rather than left to the composer.
 */

const detector = createSeedIntentDetector();

describe('an unambiguous opening', () => {
  it.each([
    'I need a pending order for Acme with three line items',
    'give me an overdue invoice',
    'I want a customer with an overdue invoice',
    'get me a draft order',
    'seed an account',
    'generate a pending order',
    'we need an account in arrears',
  ])('routes %j to the seed flow', (utterance) => {
    const intent = detector.detect(utterance);
    expect(intent.isSeed).toBe(true);
    expect(intent.certainty).toBe('unambiguous');
  });

  it('strips the trigger from the subject but leaves the rest intact', () => {
    const intent = detector.detect('I need a pending order for Acme');
    expect(intent.trigger).toBe('i need');
    expect(intent.subject).toBe('a pending order for acme');
  });

  it('routes a bare trigger to the seed flow with an empty subject', () => {
    // "I need…" and nothing else. It is still a request for data; the composer will refuse it and
    // name what it could not fill, which is a better answer than a click into space.
    const intent = detector.detect('I need');
    expect(intent.isSeed).toBe(true);
    expect(intent.subject).toBe('');
  });
});

describe('an opening that is also a button label', () => {
  it.each(['create order', 'add', 'new invoice', 'create', 'set up'])(
    'leaves %j to the runtime, because a control is labelled exactly that',
    (utterance) => {
      expect(detector.detect(utterance).isSeed).toBe(false);
    },
  );

  it.each([
    ['create an order for Acme', 'for'],
    ['add an invoice with three line items', 'with'],
    ['new order that is overdue', 'that'],
    ['create an order with 3 lines', 'a digit'],
    ['add a customer having two accounts', 'having'],
  ])('routes %j to the seed flow — it carries a qualifier (%s)', (utterance) => {
    const intent = detector.detect(utterance);
    expect(intent.isSeed).toBe(true);
    expect(intent.certainty).toBe('qualified');
  });
});

describe('an ordinary command', () => {
  it.each([
    'open orders',
    'approve the acme order',
    'click submit',
    'show only the pending ones',
    'filter by pending',
    'go back',
    'two',
    '',
  ])('leaves %j to the runtime', (utterance) => {
    const intent = detector.detect(utterance);
    expect(intent.isSeed).toBe(false);
    expect(intent.trigger).toBeNull();
  });

  it('does not match a trigger that merely appears inside the phrase', () => {
    // "Create" is a trigger at the start of an utterance, not in the middle of one. A button
    // labelled "Order create" is a button.
    expect(detector.detect('click the create button').isSeed).toBe(false);
  });
});

describe('the lexicon', () => {
  it('is overridable, so vocabulary stays data rather than a constant in the fork', () => {
    const custom = createSeedIntentDetector({
      lexicon: { unambiguous: ['ich brauche'], ambiguous: [] },
    });
    expect(custom.detect('ich brauche eine Rechnung').isSeed).toBe(true);
    // The default triggers are replaced, not extended: a locale pack is a different table.
    expect(custom.detect('I need an invoice').isSeed).toBe(false);
  });

  it('matches the longest trigger, so a longer opening is not read as a shorter one', () => {
    const intent = detector.detect('I need to have an order for Acme');
    expect(intent.trigger).toBe('i need to have');
    expect(intent.subject).toBe('an order for acme');
  });
});
