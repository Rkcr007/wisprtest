import { describe, expect, it } from 'vitest';

import { PALETTE_TOKENS, STRUCTURAL_TOKENS, TOKENS, tokensCss, tokenVar } from './tokens.js';

/**
 * The palette is a contract, not a preference.
 *
 * docs/BUILD-PLAN.md Phase 6 names these five values, and the console (Phase 18) renders against
 * the same tokens. A "small tweak" to one of them changes what a colour means in two surfaces at
 * once, so it should have to change a test that says so out loud.
 */
describe('the palette', () => {
  it('holds the five product colours at their specified values', () => {
    const palette = Object.fromEntries(PALETTE_TOKENS.map((token) => [token.name, token.value]));

    expect(palette).toEqual({
      signal: '#FFB454',
      commit: '#52E0AC',
      seed: '#C88BFF',
      memory: '#7FA8FF',
      drift: '#FF6B4A',
    });
  });

  it('states what every token means, in the token itself', () => {
    // The meaning is emitted into the stylesheet as a comment, so it travels with the artifact
    // rather than living in a document nobody opens while picking a colour.
    for (const token of TOKENS) {
      expect(token.meaning.trim(), token.name).not.toBe('');
    }

    // The palette carries the product's vocabulary, so those five have to say more than what
    // they are used for — they have to say what a tester should conclude from seeing them.
    for (const token of PALETTE_TOKENS) {
      expect(token.meaning.length, token.name).toBeGreaterThan(60);
    }
  });

  it('has no duplicate names', () => {
    const names = TOKENS.map((token) => token.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('tokensCss', () => {
  it('declares every token on both :host and :root', () => {
    // `:host` is the shadow root the extension adopts it into; `:root` is the console's document.
    // One text has to work in both or the two surfaces need two stylesheets.
    expect(tokensCss).toContain(':host, :root {');

    for (const token of TOKENS) {
      expect(tokensCss, token.name).toContain(`--wispr-${token.name}: ${token.value};`);
    }
  });

  it('carries each token meaning into the stylesheet as a comment', () => {
    for (const token of PALETTE_TOKENS) {
      expect(tokensCss).toContain(token.meaning.slice(0, 40));
    }
  });

  it('zeroes motion durations under prefers-reduced-motion', () => {
    // Removing motion at the source is what makes it true for components that do not know
    // reduced motion exists — which is every component added after this one.
    const reduced = tokensCss.slice(tokensCss.indexOf('@media (prefers-reduced-motion: reduce)'));

    expect(reduced).toContain('--wispr-duration-fast: 0ms;');
    expect(reduced).toContain('--wispr-duration-medium: 0ms;');
  });

  it('puts the HUD below the top of the stacking range, not at it', () => {
    // Room is left above the HUD deliberately: a browser-level overlay must be able to sit on
    // top of it.
    const zIndex = STRUCTURAL_TOKENS.find((token) => token.name === 'z-hud');
    expect(Number(zIndex?.value)).toBeLessThan(2_147_483_647);
    expect(Number(zIndex?.value)).toBeGreaterThan(1_000_000);
  });
});

describe('tokenVar', () => {
  it('produces a usable custom property reference', () => {
    expect(tokenVar('signal')).toBe('var(--wispr-signal)');
  });
});
