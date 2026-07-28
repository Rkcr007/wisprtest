import { beforeEach, describe, expect, it } from 'vitest';

import { createResolver, type Resolver } from './resolver.js';
import { buildSnapshot, fakeEmbedder, type ScreenSpec } from './testing.js';

const STATE = 'a'.repeat(64);

describe('resolve(utterance) across the tiers', () => {
  let resolver: Resolver;
  let live: Element[];

  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <section aria-label="Orders">
          <a href="/orders?status=pending" data-testid="filter-pending">Show pending only</a>
          <button data-testid="approve">Approve order</button>
        </section>
      </main>
    `;
    live = [...document.body.querySelectorAll('a, button')];
    const screens: ScreenSpec[] = [
      {
        stateFingerprint: STATE,
        routePattern: '/orders',
        label: 'Orders',
        elements: [
          { element: live[0] as Element, elementKey: 'orders.orders.filter-pending' },
          { element: live[1] as Element, elementKey: 'orders.orders.approve' },
        ],
      },
    ];
    const built = buildSnapshot(screens);
    const filterId = built.idByKey.get('orders.orders.filter-pending') ?? '';

    // A second build carrying the alias would reassign ids; instead the snapshot is rebuilt once
    // with the alias pointing at the id we just learned.
    const withAlias = buildSnapshot(screens, [
      {
        phrase: 'the pending filter',
        elementId: filterId,
        stateFingerprint: STATE,
        source: 'indexed',
      },
    ]);
    // Re-point the alias at the id from the *withAlias* build, since ids are per-build.
    const rebuiltFilterId = withAlias.idByKey.get('orders.orders.filter-pending') ?? '';
    const aliasRow = withAlias.snapshot.aliases[0];
    if (aliasRow !== undefined) {
      withAlias.snapshot.aliases[0] = { ...aliasRow, elementId: rebuiltFilterId };
    }

    resolver = createResolver({
      snapshot: withAlias.snapshot,
      embedder: fakeEmbedder({
        'Show pending only': [1, 0],
        'Approve order': [0, 1],
        'show me only the pending ones': [1, 0],
        gibberish: [0, 0, 1],
      }),
      config: { queryInstruction: '' },
      source: { current: () => ({ stateFingerprint: STATE, candidates: live }) },
      now: () => 0,
    });
  });

  it('resolves an exact name at T0 without embedding', async () => {
    const result = await resolver.resolve('Approve order');
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') throw new Error('unreachable');
    expect(result.tier).toBe('T0');
    expect(result.elementKey).toBe('orders.orders.approve');
  });

  it('resolves an alias at T0', async () => {
    const result = await resolver.resolve('the pending filter');
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') throw new Error('unreachable');
    expect(result.tier).toBe('T0');
    expect(result.elementKey).toBe('orders.orders.filter-pending');
  });

  it('falls through to T1 for a paraphrase T0 cannot match', async () => {
    const result = await resolver.resolve('show me only the pending ones');
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') throw new Error('unreachable');
    expect(result.tier).toBe('T1');
    expect(result.elementKey).toBe('orders.orders.filter-pending');
  });

  it('reports not_found when neither tier matches', async () => {
    const result = await resolver.resolve('gibberish');
    expect(result.outcome).toBe('not_found');
    expect(result.tier).toBe('T1');
  });
});
