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

  describe('on a drifted screen', () => {
    // Phase 17's degraded mode. Memory for this screen is known to describe a page that changed,
    // and a high score only says the phrase matched what memory holds — not that memory is true.
    const config = resolveClassifyConfig();

    it('forces ambiguous regardless of how confident the resolution was', () => {
      expect(classifyAction('click', 1, config, { screenDrifted: true })).toBe('A');
      expect(classifyAction('focus', 1, config, { screenDrifted: true })).toBe('A');
    });

    it('forces ambiguous for every verb, including the reversible ones', () => {
      for (const verb of [
        'navigate',
        'back',
        'focus',
        'scroll',
        'check',
        'type',
        'filter',
        'select',
        'click',
      ] as const) {
        expect(classifyAction(verb, above, config, { screenDrifted: true })).toBe('A');
      }
    });

    it('cannot be overridden by a verb table that narrows a click to R', () => {
      // The per-app override says what a click does when memory is accurate. It says nothing about
      // a screen that has changed underneath it, so drift is checked first.
      const narrowed = resolveClassifyConfig({
        verbClasses: { ...DEFAULT_VERB_CLASSES, click: 'R' },
      });
      expect(classifyAction('click', above, narrowed, { screenDrifted: true })).toBe('A');
    });

    it('changes nothing when the screen still matches memory', () => {
      expect(classifyAction('click', above, config, { screenDrifted: false })).toBe('C');
      expect(classifyAction('focus', above, config, { screenDrifted: false })).toBe('R');
    });

    it('defaults to not drifted when no context is given', () => {
      expect(classifyAction('focus', above, config)).toBe('R');
      expect(classifyAction('focus', above, config, {})).toBe('R');
    });
  });
});
