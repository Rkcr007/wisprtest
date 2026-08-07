import { describe, expect, it } from 'vitest';
import type { MemorySnapshot, ScreenNode } from 'protocol';

import { createDriftDetector } from './detect.js';
import type { LiveRuntimeState } from '../runtime/state-engine.js';

/**
 * The detector's whole job is deciding what is *not* drift, so that is what most of this asserts.
 * Every false report costs a human's attention in the console's review queue, and a report against
 * a screen the crawl never reached would propose a diff about a screen memory does not hold.
 */

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const APPLICATION_ID = '00000000-0000-4000-8000-000000000002';
const MEMORY_VERSION_ID = '00000000-0000-4000-8000-000000000003';
const ORDERS_SCREEN_ID = '00000000-0000-4000-8000-000000000004';

const INDEXED_HASH = 'a'.repeat(64);
const LIVE_HASH = 'b'.repeat(64);

function screen(overrides: Partial<ScreenNode> = {}): ScreenNode {
  return {
    id: ORDERS_SCREEN_ID,
    memoryVersionId: MEMORY_VERSION_ID,
    routePattern: '/orders/:id',
    stateFingerprint: 'orders-detail',
    label: 'Order detail',
    structuralHash: INDEXED_HASH,
    indexedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function snapshotOf(screens: readonly ScreenNode[]): MemorySnapshot {
  return {
    tenantId: TENANT_ID,
    applicationId: APPLICATION_ID,
    memoryVersion: {
      id: MEMORY_VERSION_ID,
      tenantId: TENANT_ID,
      applicationId: APPLICATION_ID,
      version: 1,
      status: 'active',
      createdAt: '2026-08-01T00:00:00.000Z',
      approvedBy: null,
      failureReason: null,
    },
    screens: [...screens],
    elements: [],
    navEdges: [],
    aliases: [],
    generatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function liveState(overrides: Partial<LiveRuntimeState> = {}): LiveRuntimeState {
  return {
    route: '/orders/4903',
    routePattern: '/orders/:id',
    modalStack: [],
    focusedLandmark: null,
    visibleSet: new Set<Element>(),
    structuralHash: LIVE_HASH,
    stateFingerprint: 'orders-detail',
    capturedAt: '2026-08-07T12:00:00.000Z',
    ...overrides,
  };
}

describe('createDriftDetector', () => {
  it('reports a mismatch against the screen that shares the state fingerprint', () => {
    const detector = createDriftDetector(snapshotOf([screen()]));

    expect(detector.detect(liveState())).toEqual({
      screenId: ORDERS_SCREEN_ID,
      routePattern: '/orders/:id',
      route: '/orders/4903',
      stateFingerprint: 'orders-detail',
      expectedStructuralHash: INDEXED_HASH,
      observedStructuralHash: LIVE_HASH,
      observedAt: '2026-08-07T12:00:00.000Z',
    });
  });

  it('carries the concrete route, not the pattern a reconcile could not navigate to', () => {
    const detector = createDriftDetector(snapshotOf([screen()]));
    const observation = detector.detect(liveState({ route: '/orders/4903' }));

    expect(observation?.route).toBe('/orders/4903');
    expect(observation?.routePattern).toBe('/orders/:id');
  });

  it('takes the route pattern from memory rather than from the live state', () => {
    // They agree in practice because the same `toRoutePattern` derives both. Memory is the side
    // that names the screen, so a report identifies it the way the reconcile will look it up.
    const detector = createDriftDetector(
      snapshotOf([screen({ routePattern: '/orders/:orderId' })]),
    );

    expect(detector.detect(liveState())?.routePattern).toBe('/orders/:orderId');
  });

  it('is silent when the live hash still matches memory', () => {
    const detector = createDriftDetector(snapshotOf([screen()]));

    expect(detector.detect(liveState({ structuralHash: INDEXED_HASH }))).toBeNull();
  });

  it('is silent on a screen no memory version holds', () => {
    // Unindexed, not changed — the crawl's bounds may simply never have reached it. There is no
    // screenId to report against, and inventing one would propose a diff about nothing.
    const detector = createDriftDetector(snapshotOf([screen()]));

    expect(detector.detect(liveState({ stateFingerprint: 'settings-billing' }))).toBeNull();
  });

  it('is silent before the engine has settled on a hash', () => {
    // The engine primes `structuralHash` before its streams attach and recomputes it only once a
    // route settles. Reporting from inside that window would claim the whole screen changed.
    const detector = createDriftDetector(snapshotOf([screen()]));

    expect(detector.detect(liveState({ structuralHash: '' }))).toBeNull();
  });

  it('is silent when the same route pattern is a different screen', () => {
    // `/orders/:id` with a dialog open is a different screen from `/orders/:id` without one, and
    // the dialog's screen has its own hash. Matching on route pattern would compare the live page
    // against the wrong stored hash and report drift on every modal open.
    const detector = createDriftDetector(
      snapshotOf([
        screen(),
        screen({
          id: '00000000-0000-4000-8000-000000000005',
          stateFingerprint: 'orders-detail+confirm',
          structuralHash: LIVE_HASH,
        }),
      ]),
    );

    expect(detector.detect(liveState({ stateFingerprint: 'orders-detail+confirm' }))).toBeNull();
  });

  it('does not raise a route a reconcile could not navigate to', () => {
    // RFC 3986 permits `:` inside a path segment. `DriftRaiseRequest` refines it away, so a report
    // carrying one would be rejected by a validation error nobody is watching for.
    const detector = createDriftDetector(snapshotOf([screen()]));

    expect(detector.detect(liveState({ route: '/orders/:id' }))).toBeNull();
  });

  it('does not treat a colon inside a segment as a pattern placeholder', () => {
    const detector = createDriftDetector(snapshotOf([screen()]));

    expect(detector.detect(liveState({ route: '/orders/a:b' }))?.route).toBe('/orders/a:b');
  });

  it('resolves a duplicated fingerprint to the same screen every time', () => {
    const detector = createDriftDetector(
      snapshotOf([screen(), screen({ id: '00000000-0000-4000-8000-000000000006' })]),
    );

    expect(detector.detect(liveState())?.screenId).toBe(ORDERS_SCREEN_ID);
    expect(detector.detect(liveState())?.screenId).toBe(ORDERS_SCREEN_ID);
  });
});
