import { describe, expect, it } from 'vitest';
import type { ElementFingerprint } from 'protocol';

import { assembleSnapshot } from './assemble.js';

const HASH = 'a'.repeat(64);
const FP: ElementFingerprint = {
  role: 'link',
  tagName: 'a',
  accessibleNameHash: HASH,
  accessibleNameRedacted: 'Orders',
  landmarkPath: ['navigation'],
  stableAttributes: { 'data-testid': 'nav-orders' },
  ordinal: 0,
  textShingleHash: HASH,
  bbox: { x: 0, y: 0, width: 0.1, height: 0.05 },
};

describe('assembleSnapshot', () => {
  it('emits a contract-valid snapshot from one screen and one edge', () => {
    const snapshot = assembleSnapshot({
      tenantId: '00000000-0000-4000-8000-000000000001',
      applicationId: '00000000-0000-4000-8000-000000000002',
      memoryVersionId: '00000000-0000-4000-8000-000000000003',
      generatedAt: '2026-08-29T12:00:00.000Z',
      idGen: () => '00000000-0000-4000-8000-000000000099',
      screens: [
        {
          id: '00000000-0000-4000-8000-000000000010',
          indexed: {
            url: 'http://127.0.0.1/orders',
            routePattern: '/orders',
            stateFingerprint: HASH,
            structuralHash: HASH,
            label: 'Orders',
            elements: [{ elementKey: 'orders.nav.orders', fingerprint: FP, confidence: 0.95 }],
          },
          elementIds: new Map([['orders.nav.orders', '00000000-0000-4000-8000-000000000020']]),
        },
        {
          id: '00000000-0000-4000-8000-000000000011',
          indexed: {
            url: 'http://127.0.0.1/',
            routePattern: '/',
            stateFingerprint: 'b'.repeat(64),
            structuralHash: HASH,
            label: 'Home',
            elements: [],
          },
          elementIds: new Map(),
        },
      ],
      edges: [
        {
          fromScreenId: '00000000-0000-4000-8000-000000000011',
          fromRoutePattern: '/',
          toScreenId: '00000000-0000-4000-8000-000000000010',
          triggerElementKey: 'orders.nav.orders',
          confidence: 1,
        },
      ],
    });

    expect(snapshot.memoryVersion.status).toBe('active');
    expect(snapshot.screens).toHaveLength(2);
    expect(snapshot.elements).toHaveLength(1);
    expect(snapshot.elements[0]?.stability).toBe(0);
    expect(snapshot.aliases).toEqual([]);
    // The trigger lived on Home, which has no element id for that key — the edge is dropped
    // rather than written against a guess, same as the job runner.
    expect(snapshot.navEdges).toHaveLength(0);
  });

  it('keeps an edge whose trigger was indexed on the from-screen', () => {
    const snapshot = assembleSnapshot({
      tenantId: '00000000-0000-4000-8000-000000000001',
      applicationId: '00000000-0000-4000-8000-000000000002',
      memoryVersionId: '00000000-0000-4000-8000-000000000003',
      generatedAt: '2026-08-29T12:00:00.000Z',
      idGen: () => '00000000-0000-4000-8000-000000000099',
      screens: [
        {
          id: '00000000-0000-4000-8000-000000000010',
          indexed: {
            url: 'http://127.0.0.1/',
            routePattern: '/',
            stateFingerprint: HASH,
            structuralHash: HASH,
            label: 'Home',
            elements: [{ elementKey: 'home.nav.orders', fingerprint: FP, confidence: 0.95 }],
          },
          elementIds: new Map([['home.nav.orders', '00000000-0000-4000-8000-000000000020']]),
        },
        {
          id: '00000000-0000-4000-8000-000000000011',
          indexed: {
            url: 'http://127.0.0.1/orders',
            routePattern: '/orders',
            stateFingerprint: 'b'.repeat(64),
            structuralHash: HASH,
            label: 'Orders',
            elements: [],
          },
          elementIds: new Map(),
        },
      ],
      edges: [
        {
          fromScreenId: '00000000-0000-4000-8000-000000000010',
          fromRoutePattern: '/',
          toScreenId: '00000000-0000-4000-8000-000000000011',
          triggerElementKey: 'home.nav.orders',
          confidence: 1,
        },
      ],
    });

    expect(snapshot.navEdges).toHaveLength(1);
    expect(snapshot.navEdges[0]?.triggerElementId).toBe('00000000-0000-4000-8000-000000000020');
    expect(snapshot.navEdges[0]?.preconditions).toEqual([
      { kind: 'route_matches', routePattern: '/' },
      { kind: 'element_visible', elementKey: 'home.nav.orders' },
    ]);
  });
});
