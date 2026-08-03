import type { MaterializerDescriptor } from 'protocol';
import { describe, expect, it } from 'vitest';

import { isStale, orderDescriptors } from './chain.js';

/**
 * The chain's ordering rules.
 *
 * A unit suite because these are decisions, not plumbing, and both of them are the kind that is
 * easy to get subtly wrong and impossible to notice afterwards: a materializer that ran when it
 * should have been demoted looks exactly like one that was supposed to run, right up until it
 * replays a request the application stopped honouring three weeks ago and the tester is told a
 * record exists that does not.
 *
 * docs/TEST-DATA-ENGINE.md § 4: "Materializer verification has a TTL; an unverified-in-N-days API
 * materializer drops below UI in priority until re-verified."
 */

const NOW = new Date('2026-08-03T12:00:00.000Z');
const SCHEMA_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function descriptor(
  kind: 'api' | 'ui' | 'fixture',
  overrides: Partial<MaterializerDescriptor> = {},
): MaterializerDescriptor {
  const spec: MaterializerDescriptor['spec'] =
    kind === 'api'
      ? {
          kind: 'api',
          method: 'POST',
          path: '/api/v2/orders',
          payloadTemplate: {},
          auth: 'session',
          readBackPath: '/api/v2/orders/:id',
        }
      : kind === 'ui'
        ? { kind: 'ui', form: 'orders-new.create-order', route: '/orders/new' }
        : { kind: 'fixture', command: 'rake db:seed:order' };

  return {
    id: SCHEMA_ID,
    entitySchemaId: SCHEMA_ID,
    spec,
    priority: kind === 'fixture' ? 0 : kind === 'api' ? 1 : 2,
    verifiedAt: daysAgo(1),
    verificationTtlHours: 168,
    ...overrides,
  };
}

function kinds(descriptors: readonly MaterializerDescriptor[]): string[] {
  return descriptors.map((entry) => entry.spec.kind);
}

describe('staleness', () => {
  it('treats the UI adapter as never stale', () => {
    // There is nothing to verify: driving the real form and asserting the record is reachable
    // *is* the proof, every time it runs. Demoting it would push the one always-available
    // adapter below adapters that might not work at all.
    expect(isStale(descriptor('ui', { verifiedAt: null }), NOW)).toBe(false);
    expect(isStale(descriptor('ui', { verifiedAt: daysAgo(400) }), NOW)).toBe(false);
  });

  it('treats a never-verified replay as stale', () => {
    // The state every API materializer starts in: the crawl inferred it from an observed request
    // and could not prove it creates anything, because proving that means creating one.
    expect(isStale(descriptor('api', { verifiedAt: null }), NOW)).toBe(true);
  });

  it('goes stale once the TTL has passed, and not before', () => {
    const fresh = descriptor('api', { verifiedAt: daysAgo(6), verificationTtlHours: 168 });
    const lapsed = descriptor('api', { verifiedAt: daysAgo(8), verificationTtlHours: 168 });

    expect(isStale(fresh, NOW)).toBe(false);
    expect(isStale(lapsed, NOW)).toBe(true);
  });
});

describe('ordering', () => {
  it('runs fixture, then api, then ui when all are verified', () => {
    expect(
      kinds(orderDescriptors([descriptor('ui'), descriptor('api'), descriptor('fixture')], NOW)),
    ).toEqual(['fixture', 'api', 'ui']);
  });

  it('drops an unverified api materializer below the ui one', () => {
    const ordered = orderDescriptors(
      [descriptor('ui'), descriptor('api', { verifiedAt: daysAgo(9) })],
      NOW,
    );

    // The whole point: a stale replay still runs, it just runs after the adapter that cannot be
    // stale. Excluding it would throw away a fast path that is probably still fine; trusting it
    // would silently test nothing.
    expect(kinds(ordered)).toEqual(['ui', 'api']);
  });

  it('keeps a stale materializer last when there is no ui adapter to sit behind', () => {
    const ordered = orderDescriptors(
      [descriptor('api', { verifiedAt: null }), descriptor('fixture', { verifiedAt: daysAgo(1) })],
      NOW,
    );

    expect(kinds(ordered)).toEqual(['fixture', 'api']);
  });

  it('leaves a single materializer alone', () => {
    expect(kinds(orderDescriptors([descriptor('ui')], NOW))).toEqual(['ui']);
    expect(orderDescriptors([], NOW)).toEqual([]);
  });
});
