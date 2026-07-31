import {
  computeFingerprint,
  computeStateFingerprint,
  interactiveCandidates,
  type PageContext,
  type Rect,
} from 'fingerprint';
import { Window } from 'happy-dom';
import type { ResolutionResult } from 'protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ElementKeyMinter } from '../../../indexer/src/crawl/element-key.js';
import { FixtureState, type Order } from '../../../indexer/test/fixture-app/data.js';
import * as views from '../../../indexer/test/fixture-app/views.js';
import type { Embedder } from '../../src/resolver/embedder.js';
import { createResolver, type Resolver } from '../../src/resolver/index.js';
import { buildSnapshot } from '../../src/resolver/testing.js';
import { loadNodeEmbedder } from './embedder-node.js';

/**
 * The resolver, end to end, against the Phase 5 fixture application.
 *
 * "index it, load the snapshot, assert that a set of ~20 natural phrasings resolve to the correct
 * elements at the expected tiers" (docs/BUILD-PLAN.md Phase 8). Indexing here is the real thing in
 * miniature: each fixture page is fingerprinted with the *shared* `packages/fingerprint` and keyed
 * with the *indexer's own* `ElementKeyMinter`, so the memory these resolutions run against is
 * shaped exactly as a crawl's would be — and the embeddings are the real bge-small model's, not a
 * stand-in.
 *
 * happy-dom has no layout engine, so `getBoundingClientRect` returns zeroes and the bbox signal
 * cannot separate a table's four identical "View" links. A deterministic `measure` supplies each
 * element a stable box by document order, standing in for the layout a real browser has — which is
 * what lets the duplicate-control ambiguities resolve the way they would in Chrome.
 */

/**
 * The fixture's own records, not a copy of them.
 *
 * A hand-written list here would be a second definition of what the application holds, and it
 * would go quietly stale the next time the fixture gains a field — which is exactly what these
 * tests exist to notice about the *real* thing.
 */
const ORDERS: readonly Order[] = new FixtureState().orders;

let embedder: Embedder;

beforeAll(async () => {
  embedder = await loadNodeEmbedder();
}, 120_000);

afterAll(async () => {
  await embedder.dispose();
});

/** A stable per-element box by document order, standing in for the layout happy-dom lacks. */
function measureFor(doc: Document): (element: Element) => Rect {
  const order = new Map<Element, number>();
  let index = 0;
  for (const element of doc.querySelectorAll('*')) order.set(element, index++);
  return (element) => ({ x: 0, y: (order.get(element) ?? 0) * 24, width: 160, height: 20 });
}

interface Screen {
  readonly resolver: Resolver;
  /** Element key for a data-testid, so an assertion can name the control it expects. */
  readonly keyByTestId: Map<string, string>;
}

interface AliasSeed {
  readonly phrase: string;
  readonly testId: string;
}

/** Fingerprint a fixture page, mint keys, and stand up a resolver over the resulting snapshot. */
function indexScreen(
  html: string,
  routePattern: string,
  aliases: readonly AliasSeed[] = [],
): Screen {
  const window = new Window();
  window.document.write(html);
  const doc = window.document as unknown as Document;
  const measure = measureFor(doc);
  const context: PageContext = { measure };

  const elements = [...interactiveCandidates(doc.body)];
  const minter = new ElementKeyMinter(routePattern);
  const keyByTestId = new Map<string, string>();
  const specs = elements.map((element) => {
    const key = minter.mint(computeFingerprint(element, context));
    const testId = element.getAttribute('data-testid');
    if (testId !== null) keyByTestId.set(testId, key);
    return { element, elementKey: key };
  });

  const stateFingerprint = computeStateFingerprint(routePattern, [], '');
  const built = buildSnapshot(
    [{ stateFingerprint, routePattern, label: routePattern, elements: specs }],
    [],
    context,
  );

  // Alias write-backs the crawl would have produced, pointing at the ids this build assigned.
  for (const alias of aliases) {
    const elementKey = keyByTestId.get(alias.testId);
    const elementId = elementKey === undefined ? undefined : built.idByKey.get(elementKey);
    if (elementId === undefined) throw new Error(`no element for alias ${alias.phrase}`);
    built.snapshot.aliases.push({
      id: `00000000-0000-4000-8000-${String(built.snapshot.aliases.length + 900).padStart(12, '0')}`,
      tenantId: built.snapshot.tenantId,
      memoryVersionId: built.snapshot.memoryVersion.id,
      phrase: alias.phrase,
      elementId,
      stateFingerprint,
      source: 'indexed',
      hits: 5,
      createdAt: '2026-07-27T00:00:00.000Z',
    });
  }

  const resolver = createResolver({
    snapshot: built.snapshot,
    embedder,
    context,
    source: { current: () => ({ stateFingerprint, candidates: elements }) },
    now: () => 0,
  });

  return { resolver, keyByTestId };
}

function expectResolved(result: ResolutionResult, tier: 'T0' | 'T1', suffix: string): void {
  expect(result.outcome).toBe('resolved');
  if (result.outcome !== 'resolved') throw new Error('unreachable');
  expect(result.tier).toBe(tier);
  expect(result.elementKey.endsWith(suffix)).toBe(true);
}

describe('resolving natural phrasings against the fixture app', () => {
  // Several fixture `data-testid`s are 16+ characters and so are rejected by the shared
  // fingerprint's generated-value heuristic; those elements are keyed by their accessible name
  // instead — hence `open-orders` rather than `home-open-orders`, and `show-pending-only` rather
  // than `orders-filter-pending`. Asserting the real segments is asserting what the indexer would
  // actually mint.

  it('home: exact and paraphrased navigation', async () => {
    const home = indexScreen(views.homePage(4), '/');

    expectResolved(await home.resolver.resolve('open orders'), 'T0', 'open-orders');
    expectResolved(await home.resolver.resolve('open settings'), 'T0', 'open-settings');
    // A paraphrase T0 cannot match, caught by embeddings — the primary-nav "Orders" link is the
    // strongest navigation target for it.
    expectResolved(await home.resolver.resolve('take me to the orders'), 'T1', '.orders');
  });

  it('orders: exact, alias, paraphrase and ambiguity', async () => {
    const orders = indexScreen(views.ordersPage(ORDERS), '/orders', [
      { phrase: 'the pending filter', testId: 'orders-filter-pending' },
    ]);

    expectResolved(await orders.resolver.resolve('show pending only'), 'T0', 'show-pending-only');
    // Learned alias — a phrasing the crawl wrote back, now free at T0.
    expectResolved(await orders.resolver.resolve('the pending filter'), 'T0', 'show-pending-only');
    // Paraphrase — embeddings.
    expectResolved(
      await orders.resolver.resolve('show me only the pending ones'),
      'T1',
      'show-pending-only',
    );

    // The identical "Delete" buttons and "View" links, one per rendered row, are genuine
    // ambiguities: the resolver offers them for disambiguation rather than guessing which row.
    const del = await orders.resolver.resolve('delete');
    expect(del.outcome).toBe('ambiguous');
    if (del.outcome !== 'ambiguous') throw new Error('unreachable');
    expect(del.candidates.length).toBeGreaterThanOrEqual(2);
    expect(del.candidates.every((c) => c.elementKey.includes('order-delete'))).toBe(true);

    const view = await orders.resolver.resolve('view');
    expect(view.outcome).toBe('ambiguous');
    if (view.outcome !== 'ambiguous') throw new Error('unreachable');
    expect(view.candidates.length).toBeGreaterThanOrEqual(2);
    expect(view.candidates.every((c) => c.elementKey.includes('view'))).toBe(true);
  });

  it('order detail: approve and back, exact and paraphrased', async () => {
    const detail = indexScreen(views.orderDetailPage(ORDERS[0] as Order), '/orders/:id');

    expectResolved(await detail.resolver.resolve('approve order'), 'T0', 'order-approve');
    expectResolved(await detail.resolver.resolve('approve this order'), 'T1', 'order-approve');
    expectResolved(await detail.resolver.resolve('back to orders'), 'T0', 'order-back');
  });

  it('new order: the create form', async () => {
    const create = indexScreen(views.newOrderPage(), '/orders/new');

    expectResolved(await create.resolver.resolve('create order'), 'T0', 'order-create');
    // The reset button's `data-testid` is rejected as generated, so it is keyed by its label.
    expectResolved(await create.resolver.resolve('clear the form'), 'T0', 'clear-the-form');
    // The customer field, named by its label; "customer" matches the key segment at T0.
    expectResolved(await create.resolver.resolve('customer name'), 'T0', 'customer');
    // Two paraphrases of the amount field.
    expectResolved(await create.resolver.resolve('how much is the order for'), 'T1', 'amount');
    expectResolved(await create.resolver.resolve('the order amount'), 'T1', 'amount');
  });

  it('settings: save, purge and the digest field', async () => {
    const settings = indexScreen(views.settingsPage(), '/settings');

    expectResolved(await settings.resolver.resolve('save settings'), 'T0', 'settings-save');
    expectResolved(await settings.resolver.resolve('purge all orders'), 'T0', 'settings-purge');
    // The digest recipient, by an exact label match then a paraphrase.
    expectResolved(await settings.resolver.resolve('daily digest recipient'), 'T0', 'digest');
    expectResolved(
      await settings.resolver.resolve('who receives the daily summary email'),
      'T1',
      'digest',
    );
  });
});
