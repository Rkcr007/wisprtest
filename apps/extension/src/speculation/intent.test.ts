import { describe, expect, it } from 'vitest';

import { createIntentParser, EMPTY_VOCABULARY, type IntentVocabulary } from './intent.js';

const vocab: IntentVocabulary = {
  navTargets: new Set(['orders', 'settings']),
  landmarks: new Set(['orders']),
};

describe('IntentParser — verbs', () => {
  const parse = (u: string) => createIntentParser({ vocabulary: vocab }).parse(u);

  it('reads an explicit verb and the target that follows it', () => {
    expect(parse('click the approve button')).toMatchObject({
      verb: 'click',
      targetPhrase: 'approve button',
    });
  });

  it('maps committing words to click and navigation words to navigate', () => {
    expect(parse('approve it').verb).toBe('click');
    expect(parse('submit the form').verb).toBe('click');
    expect(parse('open orders').verb).toBe('navigate');
    expect(parse('go to settings').verb).toBe('navigate');
  });

  it('prefers the longest matching trigger — "go back" is back, not navigate', () => {
    expect(parse('go back').verb).toBe('back');
    expect(parse('show only pending').verb).toBe('filter');
  });

  it('infers navigation for a bare phrase the app knows as a screen', () => {
    expect(parse('orders').verb).toBe('navigate');
  });

  it('falls back to click for a bare phrase the app does not know as a place', () => {
    expect(parse('approve order').verb).toBe('click');
    // With no vocabulary at all, an unknown bare phrase is a click, never an invented verb.
    expect(createIntentParser({ vocabulary: EMPTY_VOCABULARY }).parse('orders').verb).toBe('click');
  });
});

describe('IntentParser — constraints', () => {
  const parse = (u: string) => createIntentParser({ vocabulary: vocab }).parse(u);

  it('extracts a spoken ordinal and removes it from the target', () => {
    const intent = parse('click the second view link');
    expect(intent.constraints).toContainEqual({ kind: 'ordinal', index: 2 });
    expect(intent.targetPhrase).toBe('view link');
  });

  it('extracts "number N" ordinals', () => {
    expect(parse('click number three').constraints).toContainEqual({ kind: 'ordinal', index: 3 });
  });

  it('extracts a within-landmark scope for a generic landmark', () => {
    const intent = parse('click save in the sidebar');
    expect(intent.constraints).toContainEqual({ kind: 'within', landmark: 'sidebar' });
    expect(intent.targetPhrase).toBe('save');
  });

  it('accepts an app-specific landmark only when the snapshot confirms it', () => {
    expect(parse('click view in the orders').constraints).toContainEqual({
      kind: 'within',
      landmark: 'orders',
    });
    // "graveyard" is not a known landmark, so it stays part of the target rather than a scope.
    const intent = parse('click view in the graveyard');
    expect(intent.constraints.some((c) => c.kind === 'within')).toBe(false);
  });
});

describe('IntentParser — values', () => {
  const parse = (u: string) => createIntentParser({ vocabulary: vocab }).parse(u);

  it('splits a filter value from its preposition', () => {
    const intent = parse('filter by pending');
    expect(intent.verb).toBe('filter');
    expect(intent.constraints).toContainEqual({ kind: 'value', text: 'pending' });
    // No named control, so the value doubles as the target — a "Pending" chip resolves fine.
    expect(intent.targetPhrase).toBe('pending');
  });

  it('splits a typed value from its target control', () => {
    const intent = parse('type acme into the search box');
    expect(intent.verb).toBe('type');
    expect(intent.constraints).toContainEqual({ kind: 'value', text: 'acme' });
    expect(intent.targetPhrase).toBe('search box');
  });

  it('reads a scroll direction as a value', () => {
    expect(parse('scroll down').constraints).toContainEqual({ kind: 'value', text: 'down' });
    expect(parse('scroll to the bottom').constraints).toContainEqual({
      kind: 'value',
      text: 'bottom',
    });
  });
});

describe('IntentParser — redaction', () => {
  it('redacts PII-shaped values before they enter the intent', () => {
    // The tester read an email off the screen; it must not survive into a stored intent.
    const intent = createIntentParser({ vocabulary: vocab }).parse('filter by user@corp.com');
    const value = intent.constraints.find((c) => c.kind === 'value');
    expect(value).toBeDefined();
    expect(value && 'text' in value ? value.text : '').not.toContain('user@corp.com');
  });
});
