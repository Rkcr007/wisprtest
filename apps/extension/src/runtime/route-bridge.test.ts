import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';

import { INSTALLED_ATTRIBUTE, installRouteBridge, ROUTE_EVENT } from './route-bridge.js';
import { asRuntimeWindow } from './testing.js';

/**
 * The bridge runs in a customer's application's own JavaScript world, which makes "changes
 * nothing the page can observe" a correctness property rather than a courtesy. These tests are
 * mostly about that.
 */

function freshWindow(url = 'https://app.test/orders'): Window {
  return new Window({ url });
}

describe('installRouteBridge', () => {
  it('announces a pushState the application makes', () => {
    const window = freshWindow();
    const listener = vi.fn();
    window.document.addEventListener(ROUTE_EVENT, listener);

    installRouteBridge(asRuntimeWindow(window));
    window.history.pushState({}, '', '/orders/1841');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/orders/1841');
  });

  it('announces replaceState too', () => {
    const window = freshWindow();
    const listener = vi.fn();
    installRouteBridge(asRuntimeWindow(window));
    window.document.addEventListener(ROUTE_EVENT, listener);

    window.history.replaceState({}, '', '/orders?page=2');

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('carries no payload', () => {
    const window = freshWindow();
    let received: unknown = null;
    installRouteBridge(asRuntimeWindow(window));
    window.document.addEventListener(ROUTE_EVENT, (event) => {
      received = event;
    });

    window.history.pushState({}, '', '/orders/1841');

    // The listener reads `location` itself. Passing the URL across would mean trusting a value
    // the page can forge, in exchange for nothing — and any payload at all is a channel by
    // which page content could reach the extension.
    const event = received as CustomEvent<unknown>;
    expect(event.type).toBe(ROUTE_EVENT);
    expect(event.detail).toBeNull();
    expect(event.bubbles).toBe(false);
  });

  it('does not stack a second patch when injected twice', () => {
    const window = freshWindow();
    const listener = vi.fn();
    window.document.addEventListener(ROUTE_EVENT, listener);

    installRouteBridge(asRuntimeWindow(window));
    installRouteBridge(asRuntimeWindow(window));
    window.history.pushState({}, '', '/orders/1841');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(window.document.documentElement.hasAttribute(INSTALLED_ATTRIBUTE)).toBe(true);
  });

  it('keeps the descriptors an application feature-detects on', () => {
    const window = freshWindow();
    const before = {
      name: window.history.pushState.name,
      length: window.history.pushState.length,
      source: window.history.pushState.toString(),
    };

    installRouteBridge(asRuntimeWindow(window));

    // A framework that finds `pushState.length === 0` concludes the platform is too old and
    // falls back to hash routing — a behaviour change caused entirely by our presence.
    expect(window.history.pushState.name).toBe(before.name);
    expect(window.history.pushState.length).toBe(before.length);
    expect(window.history.pushState.toString()).toBe(before.source);
  });

  it('lets a throw from the original propagate, and announces nothing', () => {
    const window = freshWindow();
    const listener = vi.fn();
    installRouteBridge(asRuntimeWindow(window));
    window.document.addEventListener(ROUTE_EVENT, listener);

    // A cross-origin URL is the case the platform rejects. Swallowing it would change the
    // application's behaviour; announcing it would fingerprint a state that never existed.
    expect(() => {
      window.history.pushState({}, '', 'https://elsewhere.test/orders');
    }).toThrow();
    expect(listener).not.toHaveBeenCalled();
    expect(window.location.origin).toBe('https://app.test');
  });
});
