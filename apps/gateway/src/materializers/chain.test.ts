import type {
  CompositionPlan,
  EntitySchema,
  MaterializerDescriptor,
  MaterializerKind,
} from 'protocol';
import { describe, expect, it } from 'vitest';

import { isStale, orderDescriptors, runChain, type ChainOptions } from './chain.js';
import type { Materializer } from './types.js';

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

/** An API materializer the crawl never saw a detail read for, so it can never verify itself. */
function apiWithoutReadBack(): MaterializerDescriptor {
  const base = descriptor('api');
  if (base.spec.kind !== 'api') throw new Error('expected an api descriptor');
  return { ...base, spec: { ...base.spec, readBackPath: null } };
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

/* ------------------------------------------------------------------ the fallback chain ------ */

const PLAN: CompositionPlan = {
  id: '9c5b94b1-35ad-49bb-b118-8e8fc24abf80',
  tenantId: SCHEMA_ID,
  sessionId: SCHEMA_ID,
  memoryVersionId: SCHEMA_ID,
  nodes: [
    {
      nodeId: 'order-1',
      entity: 'Order',
      entitySchemaId: SCHEMA_ID,
      mode: 'create',
      existingExternalRef: null,
      fields: { customer: 'Acme Industrial' },
      provenance: [],
    },
  ],
  edges: [],
  rootNodeId: 'order-1',
  materializationOrder: ['order-1'],
  constraintSet: {
    entity: 'Order',
    constraints: [{ kind: 'equals', field: 'status', value: 'pending' }],
    confidence: 0.96,
    unparsedFragments: [],
  },
  createdAt: NOW.toISOString(),
};

function schema(materializers: readonly MaterializerDescriptor[]): EntitySchema {
  return {
    id: SCHEMA_ID,
    memoryVersionId: SCHEMA_ID,
    entityName: 'Order',
    fields: [],
    materializers: [...materializers],
    predicates: [],
    observedCount: 50,
    confidence: 0.92,
    createdAt: NOW.toISOString(),
  };
}

/** An adapter that always succeeds, or always fails, and records that it was asked. */
function adapter(
  kind: MaterializerKind,
  behaviour: 'succeeds' | 'fails' | 'declines',
): Materializer {
  return {
    kind,
    canHandle: () => (behaviour === 'declines' ? { reason: `${kind} declined` } : null),
    materialize: async () =>
      await Promise.resolve(
        behaviour === 'succeeds'
          ? {
              ok: true as const,
              record: {
                externalRef: `${kind}-4903`,
                payload: {},
                inverseOp: { kind: 'none' as const, reason: 'no delete path' },
              },
            }
          : { ok: false as const, failure: { reason: `${kind} failed` } },
      ),
    revert: async () => await Promise.resolve(null),
  };
}

function options(
  materializers: readonly Materializer[],
  descriptors: readonly MaterializerDescriptor[],
): ChainOptions {
  return {
    materializers,
    schemas: new Map([[SCHEMA_ID, schema(descriptors)]]),
    tenantId: SCHEMA_ID,
    sessionId: SCHEMA_ID,
    applicationId: SCHEMA_ID,
    memoryVersionId: SCHEMA_ID,
    nodeDeadlineMs: 5_000,
    now: NOW,
  };
}

describe('falling through the chain', () => {
  it('records the failed rung and the one that worked, in order', async () => {
    // The chaos case in miniature, and the property § 4 turns on: "Never silently degrade... If
    // the API adapter created the record, client-side validation was never exercised, and the
    // tester needs to know that." Here it did not create it, and that has to be just as visible.
    const outcome = await runChain(
      PLAN,
      options(
        [adapter('api', 'fails'), adapter('ui', 'succeeds')],
        [descriptor('api'), descriptor('ui')],
      ),
    );

    expect(outcome.result.outcome).toBe('created');
    expect(outcome.result.adapterUsed).toBe('ui');
    expect(outcome.result.attempts.map((attempt) => [attempt.adapter, attempt.outcome])).toEqual([
      ['api', 'failed'],
      ['ui', 'succeeded'],
    ]);
    expect(outcome.result.attempts[0]?.reason).toBe('api failed');
    expect(outcome.records[0]?.record.externalRef).toBe('ui-4903');
  });

  it('fails the node with the last concrete reason when nothing could create it', async () => {
    const outcome = await runChain(
      PLAN,
      options(
        [adapter('api', 'fails'), adapter('ui', 'fails')],
        [descriptor('api'), descriptor('ui')],
      ),
    );

    expect(outcome.result.outcome).toBe('failed');
    expect(outcome.result.failureReason).toBe('ui failed');
    expect(outcome.records).toEqual([]);
    // A failed materialization has no verified time, whatever the attempts say.
    expect(outcome.result.verifiedAt).toBeNull();
  });
});

describe('what an attempt proves about its materializer', () => {
  it('clears a replay that failed, so it stops being tried first', async () => {
    const outcome = await runChain(
      PLAN,
      options(
        [adapter('api', 'fails'), adapter('ui', 'succeeds')],
        [descriptor('api'), descriptor('ui')],
      ),
    );

    expect(outcome.verifications).toEqual([
      {
        materializerId: SCHEMA_ID,
        kind: 'api',
        entity: 'Order',
        verified: false,
        reason: 'api failed',
      },
    ]);
  });

  it('verifies a replay that was read back afterwards', async () => {
    const outcome = await runChain(
      PLAN,
      options([adapter('api', 'succeeds')], [descriptor('api')]),
    );

    expect(outcome.verifications).toEqual([
      { materializerId: SCHEMA_ID, kind: 'api', entity: 'Order', verified: true, reason: null },
    ]);
  });

  it('proves nothing for a replay with no observed read-back', async () => {
    // It ran, and it was accepted by something. Being accepted is not the same as having created
    // a record, so this must not promote the materializer to the front of the chain.
    const outcome = await runChain(
      PLAN,
      options([adapter('api', 'succeeds')], [apiWithoutReadBack()]),
    );

    expect(outcome.result.outcome).toBe('created');
    expect(outcome.verifications).toEqual([]);
  });

  it('never records a verification for the UI adapter', async () => {
    // Nothing to verify: driving the real form is the proof, re-established on every run.
    const outcome = await runChain(PLAN, options([adapter('ui', 'succeeds')], [descriptor('ui')]));

    expect(outcome.verifications).toEqual([]);
  });

  it('does not judge an adapter that was never asked to run', async () => {
    const outcome = await runChain(
      PLAN,
      options(
        [adapter('api', 'declines'), adapter('ui', 'succeeds')],
        [descriptor('api'), descriptor('ui')],
      ),
    );

    expect(outcome.result.attempts[0]).toMatchObject({ adapter: 'api', outcome: 'skipped' });
    // A refusal is about the *plan*, not about whether the endpoint works. Clearing verification
    // here would demote a perfectly good materializer because one record did not suit it.
    expect(outcome.verifications).toEqual([]);
  });
});
