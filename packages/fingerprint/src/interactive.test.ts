import { describe, expect, it } from 'vitest';

import {
  INTERACTIVE_ROLES,
  interactiveCandidates,
  isDisabled,
  isInert,
  isInteractiveByAuthorIntent,
  isInteractiveCandidate,
  isSemanticallyHidden,
  isStyleHidden,
  isVisible,
} from './interactive.js';
import { one, render } from './testing.js';

/**
 * These predicates decide what the indexer records and what the runtime is allowed to resolve
 * against. The two consumers share this file precisely so those two sets are the same set, so
 * the tests are written against the behaviour, not against either caller.
 */
describe('isInteractiveCandidate', () => {
  it('recognises interactivity by computed role, not by tag name', () => {
    const body = render(`
      <button>Approve</button>
      <div role="button">Also a button</div>
      <a href="/orders">Orders</a>
      <a>Not a link without href</a>
      <input />
      <input type="checkbox" />
      <p>Prose</p>
      <div>Wrapper</div>
    `);

    // A `<div role="button">` is a button here for the same reason it is one to a screen reader:
    // that is the identity the whole system resolves on.
    expect(isInteractiveCandidate(one(body, 'button'))).toBe(true);
    expect(isInteractiveCandidate(one(body, 'div[role="button"]'))).toBe(true);
    expect(isInteractiveCandidate(one(body, 'a[href]'))).toBe(true);
    expect(isInteractiveCandidate(one(body, 'input:not([type])'))).toBe(true);
    expect(isInteractiveCandidate(one(body, 'input[type="checkbox"]'))).toBe(true);

    expect(isInteractiveCandidate(one(body, 'p'))).toBe(false);
    expect(isInteractiveCandidate(one(body, 'a:not([href])'))).toBe(false);
  });

  it('recognises what an author made operable without giving it a role', () => {
    const body = render(`
      <summary>More</summary>
      <select><option>One</option></select>
      <textarea></textarea>
      <div id="tabbable" tabindex="0">Focusable</div>
      <div id="editable" contenteditable="">Type here</div>
      <div id="untabbable" tabindex="-1">Programmatic focus only</div>
      <div id="plain">Plain</div>
    `);

    expect(isInteractiveByAuthorIntent(one(body, 'summary'))).toBe(true);
    expect(isInteractiveByAuthorIntent(one(body, 'select'))).toBe(true);
    expect(isInteractiveByAuthorIntent(one(body, 'textarea'))).toBe(true);
    expect(isInteractiveByAuthorIntent(one(body, '#tabbable'))).toBe(true);
    expect(isInteractiveByAuthorIntent(one(body, '#editable'))).toBe(true);

    // `tabindex="-1"` is programmatic focus, not an offer of interaction.
    expect(isInteractiveByAuthorIntent(one(body, '#untabbable'))).toBe(false);
    expect(isInteractiveByAuthorIntent(one(body, '#plain'))).toBe(false);
  });

  it('covers the roles a tester actually operates', () => {
    for (const role of ['button', 'link', 'textbox', 'checkbox', 'combobox', 'tab', 'switch']) {
      expect(INTERACTIVE_ROLES.has(role)).toBe(true);
    }
    // A heading is not something anyone clicks; including it would pad every candidate set on
    // every screen with things no utterance can mean.
    expect(INTERACTIVE_ROLES.has('heading')).toBe(false);
    expect(INTERACTIVE_ROLES.has('generic')).toBe(false);
  });
});

describe('interactiveCandidates', () => {
  it('returns descendants in document order and excludes the root', () => {
    const body = render(`
      <main id="root">
        <button id="first">First</button>
        <div><a id="second" href="/x">Second</a></div>
        <p>Prose</p>
        <input id="third" />
      </main>
    `);
    const root = one(body, '#root');

    expect(interactiveCandidates(root).map((element) => element.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('does not include the root even when the root is itself interactive', () => {
    const body = render('<div id="root" role="button"><button id="inner">Inner</button></div>');

    // `querySelectorAll` semantics, stated in the doc comment. The runtime state engine relies on
    // it: it tests an added node separately, because an added leaf has no descendants at all.
    expect(interactiveCandidates(one(body, '#root')).map((element) => element.id)).toEqual([
      'inner',
    ]);
  });
});

describe('isDisabled', () => {
  it('sees native, inherited and ARIA disabled states', () => {
    const body = render(`
      <button id="enabled">Enabled</button>
      <button id="native" disabled>Disabled</button>
      <button id="aria" aria-disabled="true">Disabled by ARIA</button>
      <button id="aria-false" aria-disabled="false">Not disabled</button>
      <fieldset disabled><button id="inherited">Inside a disabled fieldset</button></fieldset>
    `);

    expect(isDisabled(one(body, '#enabled'))).toBe(false);
    expect(isDisabled(one(body, '#native'))).toBe(true);
    expect(isDisabled(one(body, '#aria'))).toBe(true);
    expect(isDisabled(one(body, '#aria-false'))).toBe(false);
    expect(isDisabled(one(body, '#inherited'))).toBe(true);
  });
});

describe('isSemanticallyHidden', () => {
  it('follows hidden and aria-hidden up the ancestry', () => {
    const body = render(`
      <button id="shown">Shown</button>
      <button id="self" hidden>Hidden</button>
      <div hidden><button id="under-hidden">Hidden</button></div>
      <div aria-hidden="true"><button id="under-aria">Hidden</button></div>
      <div aria-hidden="false"><button id="under-false">Shown</button></div>
    `);

    expect(isSemanticallyHidden(one(body, '#shown'))).toBe(false);
    expect(isSemanticallyHidden(one(body, '#self'))).toBe(true);
    expect(isSemanticallyHidden(one(body, '#under-hidden'))).toBe(true);
    expect(isSemanticallyHidden(one(body, '#under-aria'))).toBe(true);
    expect(isSemanticallyHidden(one(body, '#under-false'))).toBe(false);
  });
});

describe('isInert', () => {
  it('follows inert up the ancestry', () => {
    const body = render(`
      <button id="live">Live</button>
      <div inert><button id="behind">Behind a modal</button></div>
    `);

    // Distinct from `aria-hidden`: `inert` removes a subtree from focus and pointer interaction,
    // which is what makes it a reachability signal rather than an accessibility-tree one.
    expect(isInert(one(body, '#live'))).toBe(false);
    expect(isInert(one(body, '#behind'))).toBe(true);
  });
});

describe('isStyleHidden', () => {
  it('reads the computed style', () => {
    const body = render(`
      <button id="shown">Shown</button>
      <button id="none" style="display: none">Gone</button>
      <button id="invisible" style="visibility: hidden">Invisible</button>
      <button id="transparent" style="opacity: 0">Transparent</button>
    `);

    expect(isStyleHidden(one(body, '#shown'))).toBe(false);
    expect(isStyleHidden(one(body, '#none'))).toBe(true);
    expect(isStyleHidden(one(body, '#invisible'))).toBe(true);
    expect(isStyleHidden(one(body, '#transparent'))).toBe(true);
  });
});

describe('isVisible', () => {
  const box = { x: 0, y: 0, width: 120, height: 32 };

  it('requires a non-trivial box and no hiding of either kind', () => {
    const body = render(`
      <button id="shown">Shown</button>
      <button id="styled" style="display: none">Styled out</button>
      <div hidden><button id="semantic">Hidden</button></div>
    `);

    expect(isVisible(one(body, '#shown'), box)).toBe(true);
    expect(isVisible(one(body, '#styled'), box)).toBe(false);
    expect(isVisible(one(body, '#semantic'), box)).toBe(false);
  });

  it('rejects a box that is at most one pixel in both directions', () => {
    const body = render('<button id="pixel">Screen-reader only</button>');
    const element = one(body, '#pixel');

    // The clip-a-control-to-a-pixel pattern. It is not something a tester can point at, and
    // indexing it would put an invisible candidate into every scoped set on the screen.
    expect(isVisible(element, { x: 0, y: 0, width: 1, height: 1 })).toBe(false);
    expect(isVisible(element, { x: 0, y: 0, width: 0, height: 0 })).toBe(false);
    expect(isVisible(element, { x: 0, y: 0, width: 2, height: 1 })).toBe(true);
  });
});
