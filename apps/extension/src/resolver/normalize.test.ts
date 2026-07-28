import { describe, expect, it } from 'vitest';

import { normalizePhrase, phrasesEqual } from './normalize.js';

describe('normalizePhrase', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizePhrase('  The   Pending  Filter ')).toBe('the pending filter');
  });

  it('turns punctuation into a separator rather than deleting it', () => {
    // "sign-in" and "sign in" must fold together, not to "signin".
    expect(normalizePhrase('Sign-In.')).toBe('sign in');
    expect(normalizePhrase('sign in')).toBe('sign in');
  });

  it('folds compatibility forms so look-alike spellings compare equal', () => {
    // A full-width "Ａ" normalises onto plain "a".
    expect(normalizePhrase('Ａpprove')).toBe('approve');
  });

  it('reports two surface spellings of the same phrase as equal', () => {
    expect(phrasesEqual('Approve order', 'approve   order!')).toBe(true);
    expect(phrasesEqual('approve', 'reject')).toBe(false);
  });

  it('reduces an all-punctuation phrase to the empty string', () => {
    expect(normalizePhrase('!!! ---')).toBe('');
  });
});
