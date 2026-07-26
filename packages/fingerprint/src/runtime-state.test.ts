import { describe, expect, it } from 'vitest';

import {
  computeStateFingerprint,
  landmarkOf,
  readFocusedLandmark,
  readModalStack,
  topmostDialog,
} from './runtime-state.js';
import { sha256Hex } from './sha256.js';
import { one, render } from './testing.js';

/**
 * The state fingerprint binds indexing to runtime: a screen is stored under it and looked up by
 * it. Two implementations that disagreed by a byte would mean the runtime finds nothing memory
 * holds, silently, on every command — so these tests pin the encoding, not merely the behaviour.
 */
describe('computeStateFingerprint', () => {
  it('hashes the three inputs from ARCHITECTURE § 3 in a fixed encoding', () => {
    expect(computeStateFingerprint('/orders/:id', ['confirm approval'], 'main')).toBe(
      sha256Hex('/orders/:id confirm approval main'),
    );
    expect(computeStateFingerprint('/orders', [], '')).toBe(sha256Hex('/orders  '));
  });

  it('joins a nested modal stack with a pipe', () => {
    expect(computeStateFingerprint('/orders', ['outer', 'inner'], '')).toBe(
      sha256Hex('/orders outer|inner '),
    );
  });

  it('separates states that differ in any one input', () => {
    const base = computeStateFingerprint('/orders', [], '');

    expect(computeStateFingerprint('/orders/:id', [], '')).not.toBe(base);
    expect(computeStateFingerprint('/orders', ['confirm'], '')).not.toBe(base);
    expect(computeStateFingerprint('/orders', [], 'region:filters')).not.toBe(base);
  });

  it('cannot be forged across a field boundary by a landmark name', () => {
    // The separators exist for this. A dialog an application labels "x main" must not be able to
    // produce the fingerprint of a different state.
    expect(computeStateFingerprint('/orders', ['x main'], '')).not.toBe(
      computeStateFingerprint('/orders', ['x'], 'main'),
    );
  });
});

describe('readModalStack', () => {
  it('finds a dialog however the application expressed one', () => {
    const body = render(`
      <dialog open aria-label="Native"></dialog>
      <div role="dialog" aria-label="ARIA role"></div>
      <div role="alertdialog" aria-label="Alert"></div>
      <div aria-modal="true" aria-label="Modal flag"></div>
      <dialog aria-label="Closed"></dialog>
    `);

    // A closed `<dialog>` is not open, and must not appear.
    expect(readModalStack(body.ownerDocument)).toEqual([
      'native',
      'aria role',
      'alert',
      'modal flag',
    ]);
  });

  it('is empty when nothing is open', () => {
    render('<main><button>Approve</button></main>');
    expect(readModalStack(document)).toEqual([]);
  });

  it('falls back to the role when a dialog has no accessible name', () => {
    render('<div role="dialog"></div>');
    expect(readModalStack(document)).toEqual(['dialog']);
  });

  it('lists nested dialogs outermost first', () => {
    render(`
      <div role="dialog" aria-label="Outer">
        <div role="alertdialog" aria-label="Inner"></div>
      </div>
    `);
    expect(readModalStack(document)).toEqual(['outer', 'inner']);
  });

  it('redacts a dialog label before returning it', () => {
    render('<div role="dialog" aria-label="Delete account for ada@example.com"></div>');

    // CLAUDE.md § "PII rule": this string goes into the state fingerprint, into a screen record
    // and into a console. A dialog title is content, and content can name a customer.
    const stack = readModalStack(document);
    expect(stack[0]).not.toContain('ada@example.com');
    expect(stack[0]).toContain('delete account for');
  });
});

describe('topmostDialog', () => {
  it('returns the innermost open dialog', () => {
    render(`
      <div id="outer" role="dialog" aria-label="Outer">
        <div id="inner" role="alertdialog" aria-label="Inner"></div>
      </div>
    `);

    // A confirmation raised from inside another dialog is the one holding the tester's
    // attention, and the only one they can reach.
    expect(topmostDialog(document)?.id).toBe('inner');
  });

  it('returns null when nothing is open', () => {
    render('<main><button>Approve</button></main>');
    expect(topmostDialog(document)).toBeNull();
  });
});

describe('readFocusedLandmark', () => {
  it('names the innermost landmark holding focus', () => {
    const body = render(`
      <main>
        <section role="region" aria-label="Filters"><input id="query" /></section>
      </main>
    `);
    (one(body, '#query') as HTMLElement).focus();

    expect(readFocusedLandmark(document)).toBe('region:filters');
  });

  it('is empty when focus is on the body or nowhere', () => {
    render('<main><button id="approve">Approve</button></main>');
    expect(readFocusedLandmark(document)).toBe('');
  });

  it('is empty when the focused element is inside no landmark', () => {
    const body = render('<button id="loose">Loose</button>');
    (one(body, '#loose') as HTMLElement).focus();
    expect(readFocusedLandmark(document)).toBe('');
  });
});

describe('landmarkOf', () => {
  it('returns the innermost landmark of an arbitrary element', () => {
    const body = render(`
      <nav aria-label="Primary">
        <div role="search" aria-label="Find"><input id="q" /></div>
      </nav>
    `);

    expect(landmarkOf(one(body, '#q'))).toBe('search:find');
  });

  it('returns an empty string outside every landmark', () => {
    const body = render('<div><button id="loose">Loose</button></div>');
    expect(landmarkOf(one(body, '#loose'))).toBe('');
  });
});
