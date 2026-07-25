import { afterEach, describe, expect, it } from 'vitest';

import { HOST_TAG, mountHudHost, type MountedHud } from './mount.js';

/**
 * The host page must be exactly as it was.
 *
 * docs/BUILD-PLAN.md Phase 6: "The HUD must never modify host page layout, steal focus, or
 * intercept host events outside its own bounds. Add a test asserting host document.body styles
 * are unchanged after mount."
 *
 * This file is that test, plus the neighbouring guarantees that make it meaningful. A QA tool
 * that changes what it is observing produces bug reports about itself, and the tester has no way
 * to tell which ones those are.
 */

let mounted: MountedHud | undefined;

function setUpHostPage(): void {
  document.body.setAttribute('style', 'margin: 40px; overflow: hidden');
  document.body.className = 'app-shell theme-dark';
  document.body.innerHTML =
    '<main id="app"><h1>Orders</h1><button id="approve">Approve</button></main>';
}

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  document.body.removeAttribute('style');
  document.body.className = '';
  document.body.innerHTML = '';
});

describe('what the mount does to the page', () => {
  it('leaves the body’s style attribute byte-identical', () => {
    setUpHostPage();
    const before = document.body.getAttribute('style');

    mounted = mountHudHost(document);

    expect(document.body.getAttribute('style')).toBe(before);
    expect(document.body.className).toBe('app-shell theme-dark');
  });

  it('does not become a child of the body', () => {
    setUpHostPage();
    const childrenBefore = [...document.body.children].map((child) => child.tagName);

    mounted = mountHudHost(document);

    // Applications style `body > *`, count it, and lay it out. Mounting on `documentElement`
    // keeps that collection exactly as the application left it.
    expect([...document.body.children].map((child) => child.tagName)).toEqual(childrenBefore);
    expect(document.body.querySelector(HOST_TAG)).toBeNull();
  });

  it('adds exactly one node to the document, and removes it again', () => {
    setUpHostPage();
    const before = document.documentElement.children.length;

    mounted = mountHudHost(document);
    expect(document.documentElement.children.length).toBe(before + 1);

    mounted.unmount();
    mounted = undefined;
    expect(document.documentElement.children.length).toBe(before);
    expect(document.documentElement.querySelector(HOST_TAG)).toBeNull();
  });

  it('puts no stylesheet in the host document', () => {
    setUpHostPage();
    const before = document.styleSheets.length;

    mounted = mountHudHost(document);

    // Adopted into the shadow root, not injected. A `<style>` in the host document would restyle
    // the application from the moment it lands — and some applications enumerate `styleSheets`.
    expect(document.styleSheets.length).toBe(before);
    expect(document.head.querySelector('style')).toBeNull();
  });

  it('leaves the application’s own elements untouched', () => {
    setUpHostPage();
    const button = document.querySelector('#approve');
    const html = document.body.innerHTML;

    mounted = mountHudHost(document);

    expect(document.body.innerHTML).toBe(html);
    expect(document.querySelector('#approve')).toBe(button);
  });

  it('does not take focus', () => {
    setUpHostPage();
    const button = document.querySelector<HTMLElement>('#approve');
    button?.focus();

    mounted = mountHudHost(document);

    // The tester is typing into the application. An overlay that grabs focus on mount eats the
    // keystroke that was in flight.
    expect(document.activeElement).toBe(button);
  });
});

describe('the host element', () => {
  it('is isolated from the page’s CSS, and cannot contribute to its layout', () => {
    setUpHostPage();
    mounted = mountHudHost(document);

    const { style } = mounted.host;

    // Asserted through the parsed style rather than the attribute text, because engines
    // normalise it — `0` is serialised as `0px` by both happy-dom and Chrome.
    //
    // `all: initial` resets whatever the page declares for `*`, and `!important` is not
    // decoration here: pages do use `!important` on universal selectors.
    expect(style.getPropertyValue('all')).toBe('initial');
    expect(style.getPropertyPriority('all')).toBe('important');
    expect(style.getPropertyValue('position')).toBe('fixed');
    expect(style.getPropertyPriority('position')).toBe('important');

    // Zero-sized, so it can never add to the host document's scroll size.
    expect(Number.parseInt(style.getPropertyValue('width'), 10)).toBe(0);
    expect(Number.parseInt(style.getPropertyValue('height'), 10)).toBe(0);
  });

  it('passes pointer events through to the application', () => {
    setUpHostPage();
    mounted = mountHudHost(document);

    // Only the panel itself takes input. A full-viewport overlay that swallowed clicks would make
    // the application untestable, which is a memorable way to fail at being a testing tool.
    expect(mounted.host.style.getPropertyValue('pointer-events')).toBe('none');
    expect(mounted.host.style.getPropertyPriority('pointer-events')).toBe('important');
  });

  it('renders inside a shadow root, not in the page', () => {
    setUpHostPage();
    mounted = mountHudHost(document);

    expect(mounted.shadowRoot).not.toBeNull();
    expect(mounted.container.getRootNode()).toBe(mounted.shadowRoot);
    // Open, deliberately: the isolation comes from the boundary itself, and `closed` would only
    // obstruct our own tests and the tester's devtools. See the comment in `mount.ts`.
    expect(mounted.host.shadowRoot).not.toBeNull();
  });

  it('carries the design system’s styles inside that root', () => {
    setUpHostPage();
    mounted = mountHudHost(document);

    const [adopted] = mounted.shadowRoot.adoptedStyleSheets;
    const injected = mounted.shadowRoot.querySelector('style');
    const css =
      adopted === undefined
        ? (injected?.textContent ?? '')
        : [...adopted.cssRules].map((rule) => rule.cssText).join('\n');

    expect(css).toContain('--wispr-signal');
    expect(css).toContain('wispr-hud');
  });

  it('replaces an earlier mount rather than stacking a second HUD', () => {
    setUpHostPage();
    mounted = mountHudHost(document);
    const first = mounted.host;

    mounted = mountHudHost(document);

    // A second injection after a soft navigation must not leave two panels on the page.
    expect(document.documentElement.querySelectorAll(HOST_TAG)).toHaveLength(1);
    expect(first.isConnected).toBe(false);
  });
});
