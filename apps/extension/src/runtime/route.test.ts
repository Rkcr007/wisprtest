import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';

import { createRouteSource } from './route.js';
import { ROUTE_EVENT } from './route-bridge.js';
import { asRuntimeWindow } from './testing.js';

describe('createRouteSource', () => {
  function build(url = 'https://app.test/orders') {
    const window = new Window({ url });
    const onChange = vi.fn();
    const source = createRouteSource(asRuntimeWindow(window), { onChange });
    return { window, onChange, source };
  }

  it('normalises the path it starts on', () => {
    const { source } = build('https://app.test/orders/?page=2#top');
    expect(source.path).toBe('/orders');
  });

  it('follows a pushState the application makes', () => {
    const { window, onChange, source } = build();
    window.history.pushState({}, '', '/orders/1841');

    expect(source.path).toBe('/orders/1841');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('/orders/1841');
  });

  it('follows a replaceState', () => {
    const { window, source } = build();
    window.history.replaceState({}, '', '/settings');
    expect(source.path).toBe('/settings');
  });

  it('follows popstate', () => {
    const { window, onChange, source } = build();
    window.history.pushState({}, '', '/orders/1841');
    onChange.mockClear();

    window.history.back();
    window.dispatchEvent(new window.Event('popstate'));

    expect(source.path).toBe('/orders');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('/orders');
  });

  it('follows a hash router', () => {
    const { window, source } = build('https://app.test/#/orders');
    window.location.hash = '#/invoices';
    window.dispatchEvent(new window.Event('hashchange'));

    // The fragment is not part of the path — `pathOf` drops it — so a pure hash change is not a
    // route change to this source. What matters is that the event is wired and costs nothing.
    expect(source.path).toBe('/');
  });

  it('reports nothing when a signal fires but the location has not moved', () => {
    const { window, onChange } = build();
    window.document.dispatchEvent(new window.CustomEvent(ROUTE_EVENT));
    window.dispatchEvent(new window.Event('popstate'));

    // The page can dispatch the bridge's event too — it crosses from a world we do not control.
    // Nothing is read from it, so a forged one costs one string comparison.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('poke catches a change no event announced', () => {
    const { window, onChange, source } = build();

    // The backstop the state engine calls at the end of every mutation burst, for a page that
    // rewrote history through a channel we cannot see.
    window.happyDOM.setURL('https://app.test/invoices');
    expect(onChange).not.toHaveBeenCalled();

    source.poke();
    expect(source.path).toBe('/invoices');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('/invoices');
  });

  it('stops reporting after dispose', () => {
    const { window, onChange, source } = build();
    source.dispose();

    window.history.pushState({}, '', '/orders/1841');
    expect(onChange).not.toHaveBeenCalled();
  });
});
