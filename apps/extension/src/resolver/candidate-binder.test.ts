import type { ElementRecord } from 'protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { createCandidateBinder } from './candidate-binder.js';
import { buildSnapshot, type ScreenSpec } from './testing.js';

const STATE = 'a'.repeat(64);

function recordsByState(
  elements: readonly ElementRecord[],
  screens: ScreenSpec[],
): Map<string, ElementRecord[]> {
  // The unit under test wants records keyed by screen state fingerprint; in this suite every
  // record is on the single screen, so the grouping is trivial.
  return new Map(screens.map((screen) => [screen.stateFingerprint, [...elements]]));
}

function render(html: string): Element[] {
  document.body.innerHTML = html;
  return [...document.body.querySelectorAll('button, a, input')];
}

describe('binding live elements to memory records', () => {
  let liveElements: Element[];
  let screens: ScreenSpec[];
  let built: ReturnType<typeof buildSnapshot>;

  beforeEach(() => {
    liveElements = render(`
      <main>
        <section aria-label="Orders">
          <a href="/orders?status=pending" data-testid="filter-pending">Show pending only</a>
          <button data-testid="approve">Approve order</button>
        </section>
      </main>
    `);

    screens = [
      {
        stateFingerprint: STATE,
        routePattern: '/orders',
        label: 'Orders',
        elements: [
          { element: liveElements[0] as Element, elementKey: 'orders.orders.filter-pending' },
          { element: liveElements[1] as Element, elementKey: 'orders.orders.approve' },
        ],
      },
    ];
    built = buildSnapshot(screens);
  });

  it('binds each live element to the record it was fingerprinted from', () => {
    const binder = createCandidateBinder({
      recordsByState: recordsByState(built.snapshot.elements, screens),
    });
    const binding = binder.bind(STATE, liveElements);

    expect([...binding.candidateKeys].sort()).toEqual([
      'orders.orders.approve',
      'orders.orders.filter-pending',
    ]);
    // An undrifted element matches its stored fingerprint exactly.
    for (const candidate of binding.candidates) expect(candidate.integrity).toBeGreaterThan(0.99);
  });

  it('returns the same binding object for the same candidate array — the per-screen cache', () => {
    const binder = createCandidateBinder({
      recordsByState: recordsByState(built.snapshot.elements, screens),
    });
    const first = binder.bind(STATE, liveElements);
    const second = binder.bind(STATE, liveElements);
    expect(second).toBe(first);
  });

  it('still binds a renamed element, at a lower integrity', () => {
    // The label changed but the test id, role, landmark and ordinal did not — the element drifted,
    // it did not disappear. It must still bind so the resolver can see the control the tester can.
    const approve = liveElements[1] as HTMLElement;
    approve.textContent = 'Confirm the order';

    const binder = createCandidateBinder({
      recordsByState: recordsByState(built.snapshot.elements, screens),
    });
    const binding = binder.bind(STATE, liveElements);

    const bound = binding.candidates.find((c) => c.record.elementKey === 'orders.orders.approve');
    expect(bound).toBeDefined();
    expect(bound?.integrity).toBeLessThan(1);
    expect(bound?.integrity).toBeGreaterThanOrEqual(0.6);
  });

  it('drops a live element memory has no record of', () => {
    liveElements[0]?.parentElement?.insertAdjacentHTML(
      'beforeend',
      '<button data-testid="ghost">Ghost</button>',
    );
    const withGhost = [...document.body.querySelectorAll('button, a, input')];

    const binder = createCandidateBinder({
      recordsByState: recordsByState(built.snapshot.elements, screens),
    });
    const binding = binder.bind(STATE, withGhost);

    // The ghost is interactive and in scope, but not in memory, so it cannot be named — and is
    // left unbound rather than assigned an identity it does not have.
    expect(binding.candidateKeys).not.toContain('orders.orders.ghost');
    expect(binding.candidates).toHaveLength(2);
  });

  it('binds nothing on a screen memory does not know', () => {
    const binder = createCandidateBinder({
      recordsByState: recordsByState(built.snapshot.elements, screens),
    });
    const binding = binder.bind('b'.repeat(64), liveElements);
    expect(binding.candidates).toHaveLength(0);
  });
});
