import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFocusTracker } from './focus.js';

/**
 * happy-dom fires `focusin` and `focusout` for real, so these drive the DOM rather than
 * synthesising events — the point is that the tracker reads the right element at the right
 * moment, and a hand-built event would let it read the wrong one and still pass.
 */
describe('createFocusTracker', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <nav aria-label="Primary"><a id="orders" href="/orders">Orders</a></nav>
      <main>
        <section role="region" aria-label="Filters"><input id="query" /></section>
        <button id="approve">Approve</button>
      </main>
      <div id="hud-host"></div>
    `;
  });

  function focus(id: string): void {
    (document.querySelector(`#${id}`) as HTMLElement).focus();
  }

  it('names the innermost landmark holding focus', () => {
    const onChange = vi.fn();
    const tracker = createFocusTracker(document, { onChange });

    focus('query');
    expect(tracker.landmark).toBe('region:filters');
    expect(onChange).toHaveBeenLastCalledWith('region:filters');

    focus('orders');
    expect(tracker.landmark).toBe('navigation:primary');

    tracker.dispose();
  });

  it('reports an element in no landmark as an empty landmark', () => {
    document.body.innerHTML = '<button id="loose">Loose</button>';
    const tracker = createFocusTracker(document, { onChange: vi.fn() });

    focus('loose');
    expect(tracker.landmark).toBe('');
    tracker.dispose();
  });

  it('does not fire for a move within the same landmark', () => {
    document.body.innerHTML = `
      <main><button id="one">One</button><button id="two">Two</button></main>
    `;
    const onChange = vi.fn();
    const tracker = createFocusTracker(document, { onChange });

    focus('one');
    expect(onChange).toHaveBeenCalledTimes(1);
    focus('two');

    // Tabbing between two buttons in the same region is not a state change: the same controls
    // are reachable and the state fingerprint must not move.
    expect(onChange).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });

  it('clears the landmark when focus returns to the body', () => {
    const tracker = createFocusTracker(document, { onChange: vi.fn() });
    focus('approve');
    expect(tracker.landmark).toBe('main');

    (document.querySelector('#approve') as HTMLElement).blur();

    expect(tracker.landmark).toBe('');
    tracker.dispose();
  });

  it('ignores focus that lands in the HUD, keeping the application landmark', () => {
    const host = document.querySelector('#hud-host') as HTMLElement;
    const onChange = vi.fn();
    const tracker = createFocusTracker(document, {
      onChange,
      ignore: (element) => element === host,
    });

    focus('query');
    expect(tracker.landmark).toBe('region:filters');
    onChange.mockClear();

    host.setAttribute('tabindex', '-1');
    host.focus();

    // Dragging the panel must not change the state fingerprint. If it did, the scoped
    // resolution cache would be invalidated — and the same key read as drift — every time the
    // tester touched their own tool.
    expect(tracker.landmark).toBe('region:filters');
    expect(onChange).not.toHaveBeenCalled();
    tracker.dispose();
  });

  it('seeds from wherever focus already is', () => {
    focus('query');

    // The engine may well start after the application has autofocused something. A tracker that
    // assumed the body would report a state the page was never in.
    const tracker = createFocusTracker(document, { onChange: vi.fn() });
    expect(tracker.landmark).toBe('region:filters');
    tracker.dispose();
  });

  it('stops listening after dispose', () => {
    const onChange = vi.fn();
    const tracker = createFocusTracker(document, { onChange });
    tracker.dispose();

    focus('approve');
    expect(onChange).not.toHaveBeenCalled();
  });
});
