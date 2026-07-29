import { describe, expect, it } from 'vitest';

import { classifyAction, DEFAULT_VERB_CLASSES, resolveClassifyConfig } from './classify.js';

describe('classifyAction', () => {
  const above = 0.9;
  const below = 0.3;

  it('classes every click as committing above threshold', () => {
    expect(classifyAction('click', above)).toBe('C');
  });

  it('classes the reversible verbs as R above threshold', () => {
    for (const verb of [
      'navigate',
      'back',
      'focus',
      'scroll',
      'check',
      'type',
      'filter',
      'select',
    ] as const) {
      expect(classifyAction(verb, above)).toBe('R');
    }
  });

  it('overrides any verb to ambiguous below threshold — a low-confidence approve is A, not C', () => {
    // The dangerous case: a committing verb the resolver is unsure about must not surface as C
    // (which a confirmation could wave through). It is A — staged, escalated, never executed.
    expect(classifyAction('click', below)).toBe('A');
    expect(classifyAction('navigate', below)).toBe('A');
  });

  it('applies the threshold at the exact boundary — at τ it is classified, just below it is A', () => {
    const config = resolveClassifyConfig({ threshold: 0.72 });
    expect(classifyAction('click', 0.72, config)).toBe('C');
    expect(classifyAction('click', 0.7199, config)).toBe('A');
  });

  it('honours an overridden verb table, so per-app reversibility can narrow a click to R', () => {
    // The mechanism a future phase uses to carry learned "this click only expands a section".
    const config = resolveClassifyConfig({
      verbClasses: { ...DEFAULT_VERB_CLASSES, click: 'R' },
    });
    expect(classifyAction('click', above, config)).toBe('R');
  });
});
