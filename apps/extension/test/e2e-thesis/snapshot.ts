import {
  computeFingerprint,
  computeStateFingerprint,
  interactiveCandidates,
  type PageContext,
  type Rect,
} from 'fingerprint';
import { Window } from 'happy-dom';
import type { MemorySnapshot } from 'protocol';

import { ElementKeyMinter } from '../../../indexer/src/crawl/element-key.js';
import { FixtureState, type Order } from '../../../indexer/test/fixture-app/data.js';
import * as views from '../../../indexer/test/fixture-app/views.js';
import { buildSnapshot } from '../../src/resolver/testing.js';

/**
 * Index the fixture application the same way the resolver suite does: shared fingerprint
 * package, indexer's own key minter, one screen per route pattern.
 *
 * The thesis e2e then binds that snapshot to a live Chromium DOM. If those two disagree,
 * Remember → Execute is broken and the bake-off fails — which is the point.
 */

const ORDERS: readonly Order[] = new FixtureState().orders;

function measureFor(doc: Document): (element: Element) => Rect {
  const order = new Map<Element, number>();
  let index = 0;
  for (const element of doc.querySelectorAll('*')) order.set(element, index++);
  return (element) => ({ x: 0, y: (order.get(element) ?? 0) * 24, width: 160, height: 20 });
}

interface ScreenInput {
  readonly html: string;
  readonly routePattern: string;
  readonly label: string;
}

function indexScreen(input: ScreenInput): {
  readonly stateFingerprint: string;
  readonly routePattern: string;
  readonly label: string;
  readonly elements: readonly { element: Element; elementKey: string }[];
  readonly context: PageContext;
} {
  const window = new Window();
  window.document.write(input.html);
  const doc = window.document as unknown as Document;
  const context: PageContext = { measure: measureFor(doc) };
  const minter = new ElementKeyMinter(input.routePattern);
  const elements = [...interactiveCandidates(doc.body)].map((element) => ({
    element,
    elementKey: minter.mint(computeFingerprint(element, context)),
  }));
  return {
    stateFingerprint: computeStateFingerprint(input.routePattern, [], ''),
    routePattern: input.routePattern,
    label: input.label,
    elements,
    context,
  };
}

/** Build a contract-valid snapshot covering every fixture route the bake-off visits. */
export function buildFixtureSnapshot(): MemorySnapshot {
  const first = ORDERS[0];
  if (first === undefined) throw new Error('fixture state produced no orders');

  const screens = [
    indexScreen({ html: views.homePage(ORDERS.length), routePattern: '/', label: 'Home' }),
    indexScreen({ html: views.ordersPage(ORDERS), routePattern: '/orders', label: 'Orders' }),
    indexScreen({
      html: views.orderDetailPage(first),
      routePattern: '/orders/:id',
      label: 'Order detail',
    }),
    indexScreen({ html: views.newOrderPage(), routePattern: '/orders/new', label: 'New order' }),
    indexScreen({ html: views.settingsPage(), routePattern: '/settings', label: 'Settings' }),
  ];

  const built = buildSnapshot(
    screens.map((screen) => ({
      stateFingerprint: screen.stateFingerprint,
      routePattern: screen.routePattern,
      label: screen.label,
      elements: screen.elements,
    })),
    [],
    screens[0]?.context ?? {},
  );

  return withDemoAliases(built.snapshot, built.idByKey, screens);
}

/**
 * The phrases the README advertises, written back the way T2 write-back would after the first
 * encounter. The compounding loop is the thesis: first utterance may cost T1/T2; the same
 * phrasing is T0 forever after. The bake-off is that second pass, against a live DOM.
 */
function withDemoAliases(
  snapshot: MemorySnapshot,
  idByKey: ReadonlyMap<string, string>,
  screens: readonly ReturnType<typeof indexScreen>[],
): MemorySnapshot {
  const orders = screens.find((screen) => screen.routePattern === '/orders');
  const detail = screens.find((screen) => screen.routePattern === '/orders/:id');
  const pendingKey = orders?.elements.find(
    (entry) => entry.element.getAttribute('data-testid') === 'orders-filter-pending',
  )?.elementKey;
  const approveKey = detail?.elements.find(
    (entry) => entry.element.getAttribute('data-testid') === 'order-approve',
  )?.elementKey;
  const pendingId = pendingKey === undefined ? undefined : idByKey.get(pendingKey);
  const approveId = approveKey === undefined ? undefined : idByKey.get(approveKey);

  const extras: MemorySnapshot['aliases'] = [];
  let next = 0;
  const add = (
    phrase: string,
    elementId: string,
    stateFingerprint: string,
    source: 'indexed' | 't2_writeback',
  ): void => {
    next += 1;
    extras.push({
      id: `00000000-0000-4000-a000-${next.toString(16).padStart(12, '0')}`,
      tenantId: snapshot.tenantId,
      memoryVersionId: snapshot.memoryVersion.id,
      phrase,
      elementId,
      stateFingerprint,
      source,
      hits: 1,
      createdAt: snapshot.generatedAt,
    });
  };

  if (pendingId !== undefined && orders !== undefined) {
    add('pending ones', pendingId, orders.stateFingerprint, 't2_writeback');
    add('the pending ones', pendingId, orders.stateFingerprint, 't2_writeback');
    add('only the pending ones', pendingId, orders.stateFingerprint, 't2_writeback');
    add('show me only the pending ones', pendingId, orders.stateFingerprint, 't2_writeback');
  }
  if (approveId !== undefined && detail !== undefined) {
    add('approve', approveId, detail.stateFingerprint, 't2_writeback');
  }

  return { ...snapshot, aliases: [...snapshot.aliases, ...extras] };
}
