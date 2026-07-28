import type { Alias, ElementRecord } from 'protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { createCandidateBinder, type ScreenBinding } from './candidate-binder.js';
import { DEFAULT_RESOLVER_CONFIG } from './config.js';
import { buildAliasIndex, resolveT0 } from './tier0.js';
import { buildSnapshot, type ScreenSpec } from './testing.js';

const STATE = 'a'.repeat(64);

function aliasRow(phrase: string, elementId: string, stateFingerprint: string | null): Alias {
  return {
    id: '00000000-0000-4000-8000-0000000000ff',
    tenantId: '00000000-0000-4000-8000-0000000000fe',
    memoryVersionId: '00000000-0000-4000-8000-0000000000fd',
    phrase,
    elementId,
    stateFingerprint,
    source: 'indexed',
    hits: 3,
    createdAt: '2026-07-27T00:00:00.000Z',
  };
}

describe('T0 exact and alias resolution', () => {
  let binding: ScreenBinding;
  let idByKey: Map<string, string>;
  let elements: readonly ElementRecord[];

  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <section aria-label="Orders">
          <a href="/orders?status=pending" data-testid="filter-pending">Show pending only</a>
          <button data-testid="approve">Approve order</button>
          <a href="/orders/1" data-testid="view-1">View</a>
          <a href="/orders/2" data-testid="view-2">View</a>
        </section>
      </main>
    `;
    const live = [...document.body.querySelectorAll('a, button')];
    const screens: ScreenSpec[] = [
      {
        stateFingerprint: STATE,
        routePattern: '/orders',
        label: 'Orders',
        elements: [
          { element: live[0] as Element, elementKey: 'orders.orders.filter-pending' },
          { element: live[1] as Element, elementKey: 'orders.orders.approve' },
          { element: live[2] as Element, elementKey: 'orders.orders.view' },
          { element: live[3] as Element, elementKey: 'orders.orders.view-2' },
        ],
      },
    ];
    const built = buildSnapshot(screens);
    idByKey = built.idByKey;
    elements = built.snapshot.elements;

    const binder = createCandidateBinder({
      recordsByState: new Map([[STATE, [...elements]]]),
    });
    binding = binder.bind(STATE, live);
  });

  const run = (utterance: string, aliases: Alias[] = []) =>
    resolveT0(utterance, binding, buildAliasIndex(aliases), DEFAULT_RESOLVER_CONFIG, 0, () => 0);

  it('resolves an exact accessible-name match at T0', () => {
    const result = run('Approve order');
    expect(result?.outcome).toBe('resolved');
    if (result?.outcome !== 'resolved') throw new Error('unreachable');
    expect(result.elementKey).toBe('orders.orders.approve');
    expect(result.tier).toBe('T0');
  });

  it('resolves an alias hit at T0', () => {
    const filterId = idByKey.get('orders.orders.filter-pending') ?? '';
    const result = run('only the pending ones', [
      aliasRow('only the pending ones', filterId, STATE),
    ]);

    expect(result?.outcome).toBe('resolved');
    if (result?.outcome !== 'resolved') throw new Error('unreachable');
    expect(result.elementKey).toBe('orders.orders.filter-pending');
    expect(result.candidates[0]?.signalScores.alias).toBe(1);
  });

  it('prefers a screen-scoped alias, and ignores one for another screen', () => {
    const filterId = idByKey.get('orders.orders.filter-pending') ?? '';
    // An alias scoped to a different screen must not fire here.
    const elsewhere = run('pending please', [aliasRow('pending please', filterId, 'b'.repeat(64))]);
    expect(elsewhere).toBeNull();

    // The same phrase, app-wide, does fire.
    const appWide = run('pending please', [aliasRow('pending please', filterId, null)]);
    expect(appWide?.outcome).toBe('resolved');
  });

  it('returns an ambiguity for two controls with the same name', () => {
    const result = run('view');
    expect(result?.outcome).toBe('ambiguous');
    if (result?.outcome !== 'ambiguous') throw new Error('unreachable');
    expect(result.candidates.map((c) => c.elementKey).sort()).toEqual([
      'orders.orders.view',
      'orders.orders.view-2',
    ]);
  });

  it('resolves a match against the element key even with no useful name', () => {
    // "filter pending" is the element key in words; the label is "Show pending only".
    const result = run('filter pending');
    expect(result?.outcome).toBe('resolved');
    if (result?.outcome !== 'resolved') throw new Error('unreachable');
    expect(result.elementKey).toBe('orders.orders.filter-pending');
  });

  it('misses cleanly on a phrase nothing matches exactly, so T1 can try', () => {
    expect(run('show me only the pending ones')).toBeNull();
  });

  it('ignores an alias that points off-screen', () => {
    // An alias to an element that is not in the current scope is not a T0 hit.
    const result = run('gone', [aliasRow('gone', '00000000-0000-4000-8000-0000000000aa', STATE)]);
    expect(result).toBeNull();
  });
});
