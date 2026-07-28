import { beforeEach, describe, expect, it } from 'vitest';

import { createCandidateBinder, type ScreenBinding } from './candidate-binder.js';
import { DEFAULT_RESOLVER_CONFIG, type ResolverConfig } from './config.js';
import { buildSnapshot, fakeEmbedder, type FakeEmbedder, type ScreenSpec } from './testing.js';
import { createTier1Resolver } from './tier1.js';

const STATE = 'a'.repeat(64);
// No instruction prefix, so the fake embedder's table can key on the bare utterance.
const CONFIG: ResolverConfig = { ...DEFAULT_RESOLVER_CONFIG, queryInstruction: '' };

function makeBinding(): ScreenBinding {
  document.body.innerHTML = `
    <main>
      <section aria-label="Orders">
        <a href="/orders?status=pending" data-testid="filter-pending">Show pending only</a>
        <button data-testid="approve">Approve order</button>
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
      ],
    },
  ];
  const built = buildSnapshot(screens);
  const binder = createCandidateBinder({
    recordsByState: new Map([[STATE, [...built.snapshot.elements]]]),
  });
  return binder.bind(STATE, live);
}

describe('T1 embedding kNN', () => {
  let binding: ScreenBinding;

  beforeEach(() => {
    binding = makeBinding();
  });

  it('resolves the nearest candidate by cosine similarity', async () => {
    const embedder = fakeEmbedder({
      'Show pending only': [1, 0],
      'Approve order': [0, 1],
      'show me only the pending ones': [1, 0],
    });
    const tier1 = createTier1Resolver({ embedder });

    const result = await tier1.resolve(
      'show me only the pending ones',
      binding,
      CONFIG,
      0,
      () => 0,
    );

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') throw new Error('unreachable');
    expect(result.elementKey).toBe('orders.orders.filter-pending');
    expect(result.tier).toBe('T1');
  });

  it('embeds a screen once and reuses the vectors on the next utterance', async () => {
    const embedder: FakeEmbedder = fakeEmbedder({
      'Show pending only': [1, 0],
      'Approve order': [0, 1],
      pending: [1, 0],
      approve: [0, 1],
    });
    const tier1 = createTier1Resolver({ embedder });

    await tier1.resolve('pending', binding, CONFIG, 0, () => 0);
    await tier1.resolve('approve', binding, CONFIG, 0, () => 0);

    // Three embed calls: the candidate names once, then one query per utterance.
    expect(embedder.calls).toBe(3);
    expect(embedder.embeddedTexts[0]).toEqual(['Show pending only', 'Approve order']);
    expect(embedder.embeddedTexts[1]).toEqual(['pending']);
    expect(embedder.embeddedTexts[2]).toEqual(['approve']);
  });

  it('returns an ambiguity when the top two are within the margin', async () => {
    const embedder = fakeEmbedder({
      'Show pending only': [1, 0],
      'Approve order': [0, 1],
      // Equidistant from both candidates: neither leads by the margin.
      ambiguous: [1, 1],
    });
    const tier1 = createTier1Resolver({ embedder });

    const result = await tier1.resolve('ambiguous', binding, CONFIG, 0, () => 0);
    expect(result.outcome).toBe('ambiguous');
    if (result.outcome !== 'ambiguous') throw new Error('unreachable');
    expect(result.candidates).toHaveLength(2);
  });

  it('returns not_found when nothing clears the candidate floor', async () => {
    const embedder = fakeEmbedder({
      'Show pending only': [1, 0],
      'Approve order': [1, 0],
      // Orthogonal to both candidates — cosine ~0, below the floor.
      unrelated: [0, 1],
    });
    const tier1 = createTier1Resolver({ embedder });

    const result = await tier1.resolve('unrelated', binding, CONFIG, 0, () => 0);
    expect(result.outcome).toBe('not_found');
  });

  it('returns not_found on an empty scope without touching the embedder', async () => {
    const embedder = fakeEmbedder({});
    const tier1 = createTier1Resolver({ embedder });
    const empty: ScreenBinding = { stateFingerprint: STATE, candidates: [], candidateKeys: [] };

    const result = await tier1.resolve('anything', empty, CONFIG, 0, () => 0);
    expect(result.outcome).toBe('not_found');
    expect(embedder.calls).toBe(0);
  });
});
