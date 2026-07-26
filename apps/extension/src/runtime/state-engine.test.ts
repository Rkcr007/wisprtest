import { computeStateFingerprint, structuralHash, toRoutePattern } from 'fingerprint';
import { Window } from 'happy-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeState } from 'protocol';

import {
  createRuntimeStateEngine,
  toRuntimeState,
  type LiveRuntimeState,
  type RuntimeStateEngine,
} from './state-engine.js';
import {
  asElement,
  asHtmlElement,
  asNode,
  asRuntimeWindow,
  createManualIntersectionObserver,
  createManualMutationObserver,
  createManualScheduler,
  mutationRecord,
  type ManualIntersectionObserver,
  type ManualMutationObserver,
  type ManualScheduler,
} from './testing.js';

const PAGE = `
  <nav aria-label="Primary"><a id="orders" href="/orders">Orders</a></nav>
  <main>
    <section role="region" aria-label="Filters"><input id="query" /></section>
    <button id="approve">Approve</button>
  </main>
`;

describe('createRuntimeStateEngine', () => {
  let window: Window;
  let scheduler: ManualScheduler;
  let mutations: ManualMutationObserver;
  let intersection: ManualIntersectionObserver;
  let engine: RuntimeStateEngine;
  let states: LiveRuntimeState[];

  function build(html = PAGE, url = 'https://app.test/orders'): void {
    window = new Window({ url });
    window.document.body.innerHTML = html;
    scheduler = createManualScheduler();

    engine = createRuntimeStateEngine({
      window: asRuntimeWindow(window),
      scheduler,
      mutationObserverFactory: (callback) => {
        mutations = createManualMutationObserver(callback);
        return mutations.observer;
      },
      intersectionObserverFactory: (callback) => {
        intersection = createManualIntersectionObserver(callback);
        return intersection.observer;
      },
      now: () => new Date('2026-07-27T09:00:00.000Z'),
    });

    states = [];
    engine.state.subscribe((state) => states.push(state));
  }

  function el(selector: string): Element {
    const found = window.document.querySelector(selector);
    if (found === null) throw new Error(`no element matched ${selector}`);
    return asElement(found);
  }

  /** The state as it stands now — the observable always has one. */
  function current(): LiveRuntimeState {
    return engine.state.value;
  }

  beforeEach(() => {
    build();
  });

  describe('the state vector', () => {
    it('is complete before the first mutation arrives', () => {
      // A subscriber that attaches after the page has settled must see the real page, not an
      // empty placeholder it has to wait for a mutation to escape.
      const state = states[0] as LiveRuntimeState;
      expect(state.route).toBe('/orders');
      expect(state.routePattern).toBe('/orders');
      expect(state.modalStack).toEqual([]);
      expect(state.focusedLandmark).toBeNull();
      expect(state.structuralHash).toMatch(/^[0-9a-f]{64}$/);
      expect(state.capturedAt).toBe('2026-07-27T09:00:00.000Z');
    });

    it('generalises the route pattern the way the indexer does', () => {
      build(PAGE, 'https://app.test/orders/1841');

      // Not merely "looks right": `toRoutePattern` is the indexer's own function, shared through
      // packages/fingerprint. A second implementation here would be a screen key that never
      // matches anything memory holds.
      expect(current().route).toBe('/orders/1841');
      expect(current().routePattern).toBe('/orders/:id');
      expect(current().routePattern).toBe(toRoutePattern('/orders/1841'));
    });

    it('computes the state fingerprint exactly as packages/fingerprint does', () => {
      expect(current().stateFingerprint).toBe(computeStateFingerprint('/orders', [], ''));
    });

    it('computes the structural hash over the indexed root', () => {
      expect(current().structuralHash).toBe(structuralHash(asElement(window.document.body)));
    });
  });

  describe('route', () => {
    it('republishes on a pushState, with a new state fingerprint', () => {
      const before = current().stateFingerprint;
      window.history.pushState({}, '', '/invoices');

      expect(current().route).toBe('/invoices');
      expect(current().stateFingerprint).not.toBe(before);
      expect(current().stateFingerprint).toBe(computeStateFingerprint('/invoices', [], ''));
    });

    it('recomputes the structural hash when the route settles, and not before', () => {
      const original = current().structuralHash;

      window.history.pushState({}, '', '/invoices');
      window.document.body.innerHTML = '<main><button id="pay">Pay</button></main>';
      mutations.deliver([mutationRecord({ type: 'childList', target: el('main') })]);

      // Still the old hash: the DOM is mid-change, and hashing a subtree that is still moving
      // describes nothing. docs/ARCHITECTURE.md § 3 says "computed on route settle".
      expect(current().structuralHash).toBe(original);

      scheduler.runPending();

      expect(current().structuralHash).not.toBe(original);
      expect(current().structuralHash).toBe(structuralHash(asElement(window.document.body)));
    });

    it('does not rehash on a settle within the same route', () => {
      scheduler.runPending();
      const hash = current().structuralHash;

      window.document.body.innerHTML = '<main><button id="new">New</button></main>';
      mutations.deliver([
        mutationRecord({ type: 'childList', target: asNode(window.document.body) }),
      ]);
      scheduler.runPending();

      // Structural change within a route is real, and reconciling it is the Phase 17 drift loop.
      // This phase does not pre-empt it.
      expect(current().structuralHash).toBe(hash);
    });
  });

  describe('modal stack', () => {
    it('picks up a dialog on the burst that opened it, and scopes the index to it', () => {
      intersection.reportAllVisible();
      expect(engine.scopedIndex.candidates().length).toBeGreaterThan(1);

      const dialog = window.document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-label', 'Confirm approval');
      dialog.innerHTML = '<button id="yes">Yes</button>';
      window.document.body.append(dialog);

      mutations.deliver([
        mutationRecord({
          type: 'childList',
          target: asNode(window.document.body),
          addedNodes: [asNode(dialog)],
        }),
      ]);
      intersection.reportAllVisible();

      expect(current().modalStack).toEqual(['confirm approval']);
      expect(current().stateFingerprint).toBe(
        computeStateFingerprint('/orders', ['confirm approval'], ''),
      );
      // The application behind the dialog is visible but unreachable. Resolving "approve" to the
      // button underneath the confirmation asking whether to approve is the worst outcome the
      // reversibility taxonomy exists to prevent.
      expect(engine.scopedIndex.candidates().map((element) => element.id)).toEqual(['yes']);
    });

    it('releases the scope when the dialog closes', () => {
      build(`
        <main><button id="approve">Approve</button></main>
        <div id="confirm" role="dialog" aria-label="Confirm"><button id="yes">Yes</button></div>
      `);
      intersection.reportAllVisible();
      // No mutation needed: the engine primes the modal stack and the scope root at
      // construction, so an engine attached to a page that already has a dialog open is correct
      // from its first published state.
      expect(current().modalStack).toEqual(['confirm']);
      expect(engine.scopedIndex.candidates().map((element) => element.id)).toEqual(['yes']);

      const dialog = el('#confirm');
      dialog.remove();
      mutations.deliver([
        mutationRecord({
          type: 'childList',
          target: asNode(window.document.body),
          removedNodes: [asNode(dialog)],
        }),
      ]);

      expect(current().modalStack).toEqual([]);
      expect(engine.scopedIndex.candidates().map((element) => element.id)).toEqual(['approve']);
    });
  });

  describe('focus', () => {
    it('moves the state fingerprint when focus changes landmark', () => {
      asHtmlElement(el('#query')).focus();

      expect(current().focusedLandmark).toBe('region:filters');
      expect(current().stateFingerprint).toBe(
        computeStateFingerprint('/orders', [], 'region:filters'),
      );
    });
  });

  describe('visible set', () => {
    it('publishes a snapshot, not the live set', () => {
      intersection.reportAllVisible();
      const snapshot = current().visibleSet;
      const size = snapshot.size;
      expect(size).toBeGreaterThan(0);

      intersection.report([{ element: el('#approve'), isIntersecting: false }]);

      // A subscriber holding an older record must still see what was true when it was published.
      expect(snapshot.size).toBe(size);
      expect(current().visibleSet.size).toBe(size - 1);
    });
  });

  describe('the scoped index', () => {
    it('is kept in step by the engine, incrementally', () => {
      intersection.reportAllVisible();
      expect(
        engine.scopedIndex
          .candidates()
          .map((element) => element.id)
          .sort(),
      ).toEqual(['approve', 'orders', 'query']);

      const button = window.document.createElement('button');
      button.id = 'export';
      el('main').append(asNode(button));
      mutations.deliver([
        mutationRecord({
          type: 'childList',
          target: el('main'),
          addedNodes: [asNode(button)],
        }),
      ]);
      intersection.reportAllVisible();

      expect(
        engine.scopedIndex
          .candidates()
          .map((element) => element.id)
          .sort(),
      ).toEqual(['approve', 'export', 'orders', 'query']);
    });

    it('flush applies mutations the observer has queued but not delivered', () => {
      intersection.reportAllVisible();
      const button = window.document.createElement('button');
      button.id = 'export';
      el('main').append(asNode(button));

      mutations.queue([
        mutationRecord({
          type: 'childList',
          target: el('main'),
          addedNodes: [asNode(button)],
        }),
      ]);

      expect(engine.scopedIndex.has(asElement(button))).toBe(false);
      engine.flush();
      expect(engine.scopedIndex.has(asElement(button))).toBe(true);
    });
  });

  describe('lifecycle', () => {
    it('never schedules a timer on a quiet page', () => {
      // "Never polling, never setInterval." Nothing is armed until a mutation arrives, and the
      // window is not rearmed when it closes empty.
      expect(scheduler.pendingCount).toBe(0);

      mutations.deliver([
        mutationRecord({ type: 'childList', target: asNode(window.document.body) }),
      ]);
      expect(scheduler.pendingCount).toBe(1);

      scheduler.runPending();
      expect(scheduler.pendingCount).toBe(0);
    });

    it('stops publishing after dispose', () => {
      const count = states.length;
      engine.dispose();

      window.history.pushState({}, '', '/invoices');
      mutations.deliver([
        mutationRecord({ type: 'childList', target: asNode(window.document.body) }),
      ]);
      asHtmlElement(el('#query')).focus();

      expect(states).toHaveLength(count);
      expect(engine.scopedIndex.size).toBe(0);
    });

    it('does not let a throwing subscriber stop the engine', () => {
      const onError = vi.fn();
      build();
      engine.dispose();

      window = new Window({ url: 'https://app.test/orders' });
      window.document.body.innerHTML = PAGE;
      const thrower = createRuntimeStateEngine({
        window: asRuntimeWindow(window),
        scheduler: createManualScheduler(),
        onError,
      });
      const seen: LiveRuntimeState[] = [];
      thrower.state.subscribe(() => {
        throw new Error('a rendering bug in the HUD');
      });
      thrower.state.subscribe((state) => seen.push(state));

      window.history.pushState({}, '', '/invoices');

      expect(seen).toHaveLength(2);
      expect(seen[1]?.route).toBe('/invoices');
      expect(onError).toHaveBeenCalled();
      thrower.dispose();
    });
  });
});

describe('toRuntimeState', () => {
  it('produces a payload the protocol schema accepts', () => {
    const live: LiveRuntimeState = {
      route: '/orders/1841',
      routePattern: '/orders/:id',
      modalStack: ['confirm approval'],
      focusedLandmark: 'region:filters',
      visibleSet: new Set<Element>(),
      structuralHash: 'a'.repeat(64),
      stateFingerprint: 'b'.repeat(64),
      capturedAt: '2026-07-27T09:00:00.000Z',
    };

    const wire = toRuntimeState(live, ['orders.filter.pending']);

    expect(RuntimeState.parse(wire)).toEqual(wire);
    expect(wire.visibleElementKeys).toEqual(['orders.filter.pending']);
    // Empty is null on the wire: `RuntimeState.focusedLandmark` is a nullable non-empty string.
    expect(toRuntimeState({ ...live, focusedLandmark: null }, []).focusedLandmark).toBeNull();
  });
});
