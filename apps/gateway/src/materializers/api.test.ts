import type {
  CompositionNode,
  CompositionPlan,
  MaterializerDescriptor,
  SeedJob,
  SeedJobResult,
} from 'protocol';
import { describe, expect, it } from 'vitest';

import type { SeedJobDispatcher } from '../redis/seed-queue.js';
import { createApiMaterializer, fill, slotsIn, type HttpCreateReversal } from './api.js';
import type { MaterializationContext } from './types.js';

/**
 * The API adapter's judgement, which is all of it that lives in this process.
 *
 * The request itself is the indexer's, and it is tested against a real application there. What is
 * decided here is narrower and easier to get quietly wrong: whether the observed create request
 * can carry *this* record, and how the plan's fields map onto the payload's slots.
 *
 * The failure this suite is really guarding against is the silent one. A replay that drops a field
 * still returns 201, still reads the record back, and still reports success — while the order it
 * created is not pending, which is the only reason the tester asked for it.
 */

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const PAYLOAD_TEMPLATE = {
  accountId: '{{accountId}}',
  customer: '{{customer}}',
  po_number: '{{po_number}}',
  status: '{{status}}',
  lines: [{ sku: '{{lines[].sku}}', quantity: '{{lines[].quantity}}' }],
};

function descriptor(
  overrides: Partial<MaterializerDescriptor['spec']> = {},
): MaterializerDescriptor {
  return {
    id: UUID,
    entitySchemaId: UUID,
    spec: {
      kind: 'api',
      method: 'POST',
      path: '/api/v2/orders',
      payloadTemplate: PAYLOAD_TEMPLATE,
      auth: 'session',
      readBackPath: '/api/v2/orders/:id',
      ...overrides,
    } as MaterializerDescriptor['spec'],
    priority: 1,
    verifiedAt: new Date().toISOString(),
    verificationTtlHours: 168,
  };
}

function node(fields: Record<string, unknown> = {}): CompositionNode {
  return {
    nodeId: 'order-1',
    entity: 'Order',
    entitySchemaId: UUID,
    mode: 'create',
    existingExternalRef: null,
    fields: {
      accountId: 'ACC-118',
      customer: 'Acme Industrial',
      po_number: 'PO-4903',
      status: 'pending',
      'lines.sku': 'W-1',
      'lines.quantity': 3,
      ...fields,
    },
    provenance: [],
  };
}

function context(created = new Map<string, string>()): MaterializationContext {
  return {
    tenantId: UUID,
    sessionId: UUID,
    applicationId: UUID,
    memoryVersionId: UUID,
    plan: { id: UUID } as CompositionPlan,
    created,
    deadlineMs: 5_000,
  };
}

const REVERSAL: HttpCreateReversal = {
  inverseOp: { kind: 'ui', flow: 'orders.order.delete' },
  detailPath: '/orders/4903',
};

/** Captures the job instead of sending it, and answers whatever the test wants. */
function dispatcher(answer: (job: SeedJob) => SeedJobResult): {
  readonly jobs: SeedJob[];
  readonly dispatcher: SeedJobDispatcher;
} {
  const jobs: SeedJob[] = [];
  return {
    jobs,
    dispatcher: {
      run: async (job) => {
        jobs.push(job);
        return await Promise.resolve(answer(job));
      },
    },
  };
}

function created(job: SeedJob, externalRef = '4903'): SeedJobResult {
  return {
    jobId: job.jobId,
    operation: job.operation,
    outcome: 'succeeded',
    externalRef,
    detailPath: null,
    failureReason: null,
    durationMs: 120,
  };
}

describe('slot extraction', () => {
  it('finds every slot, including inside a repeated group', () => {
    expect([...slotsIn(PAYLOAD_TEMPLATE)].sort()).toEqual([
      'accountId',
      'customer',
      'lines[].quantity',
      'lines[].sku',
      'po_number',
      'status',
    ]);
  });

  it('ignores a value that merely contains braces', () => {
    expect([...slotsIn({ note: 'see {{manual}} for details' })]).toEqual([]);
  });
});

describe('filling the observed template', () => {
  it("keeps the application's own shape and replaces only the leaves", () => {
    const result = fill(PAYLOAD_TEMPLATE, new Map(Object.entries(node().fields)));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual({
      accountId: 'ACC-118',
      customer: 'Acme Industrial',
      po_number: 'PO-4903',
      status: 'pending',
      // The nesting, the key spelling and the array are the application's, from a request it
      // actually accepted. Only the values are ours.
      lines: [{ sku: 'W-1', quantity: 3 }],
    });
  });

  it('matches a slot to a field whose spelling differs', () => {
    // The form says `poNumber`, the API says `po_number`, and they are the same field — the same
    // normalisation `inferApiMaterializers` used to decide these two were related at all.
    const result = fill({ po_number: '{{po_number}}' }, new Map([['poNumber', 'PO-1']]));

    expect(result).toEqual({ ok: true, payload: { po_number: 'PO-1' } });
  });

  it('refuses rather than sending a slot as a literal', () => {
    const result = fill({ status: '{{status}}' }, new Map());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('status');
  });

  it('preserves a JSON null, which is a value and not an absence', () => {
    const result = fill({ notes: '{{notes}}' }, new Map([['notes', null]]));

    expect(result).toEqual({ ok: true, payload: { notes: null } });
  });
});

describe('deciding whether the observed request can carry this record', () => {
  const adapter = createApiMaterializer({
    dispatcher: dispatcher(created).dispatcher,
    reversalFor: () => REVERSAL,
  });

  it('accepts a plan the observed payload has room for', () => {
    expect(adapter.canHandle(node(), descriptor())).toBeNull();
  });

  it('refuses when the plan cannot fill a slot the request carries', () => {
    const missing = node();
    const fields = { ...missing.fields };
    delete fields.status;

    const refusal = adapter.canHandle({ ...missing, fields }, descriptor());

    expect(refusal?.reason).toContain('status');
    expect(refusal?.reason).toContain('empty');
  });

  it('refuses when the request has nowhere to put a composed field', () => {
    // The quiet failure, and the reason this direction is checked at all. Without it the replay
    // succeeds, the read-back passes, and the order is not the one that was asked for.
    const refusal = adapter.canHandle(node({ priority: 'urgent' }), descriptor());

    expect(refusal?.reason).toContain('priority');
    expect(refusal?.reason).toContain('would not be the one that was composed');
  });

  it('refuses a bearer-authenticated endpoint, because the token was never captured', () => {
    const refusal = adapter.canHandle(node(), descriptor({ auth: 'bearer' }));

    expect(refusal?.reason).toContain('bearer');
    expect(refusal?.reason).toContain('the UI form will run instead');
  });

  it('runs against an endpoint that needs no credential at all', () => {
    expect(adapter.canHandle(node(), descriptor({ auth: 'none' }))).toBeNull();
  });
});

describe('dispatching the replay', () => {
  it('sends the observed method, path and read-back with the filled payload', async () => {
    const spy = dispatcher(created);
    const adapter = createApiMaterializer({
      dispatcher: spy.dispatcher,
      reversalFor: () => REVERSAL,
    });

    const outcome = await adapter.materialize(node(), descriptor(), context());

    expect(outcome.ok).toBe(true);
    const [job] = spy.jobs;
    expect(job?.operation).toBe('api_create');
    if (job?.operation !== 'api_create') return;

    expect(job.method).toBe('POST');
    expect(job.path).toBe('/api/v2/orders');
    expect(job.readBackPath).toBe('/api/v2/orders/:id');
    expect(job.payload).toMatchObject({ status: 'pending', lines: [{ sku: 'W-1', quantity: 3 }] });
  });

  it('substitutes a plan-local node id for the identifier that node actually got', async () => {
    const spy = dispatcher(created);
    const adapter = createApiMaterializer({
      dispatcher: spy.dispatcher,
      reversalFor: () => REVERSAL,
    });

    // The Account node was created first and got ACC-9001; the Invoice's `accountId` still holds
    // the plan-local id. This substitution is where a dependency edge becomes a foreign key.
    await adapter.materialize(
      node({ accountId: 'account-node' }),
      descriptor(),
      context(new Map([['account-node', 'ACC-9001']])),
    );

    const [job] = spy.jobs;
    if (job?.operation !== 'api_create') throw new Error('no api job was dispatched');
    expect(job.payload).toMatchObject({ accountId: 'ACC-9001' });
  });

  it('stores the reconstructed path, since a replay never landed on one', async () => {
    const adapter = createApiMaterializer({
      dispatcher: dispatcher(created).dispatcher,
      reversalFor: () => REVERSAL,
    });

    const outcome = await adapter.materialize(node(), descriptor(), context());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.payload).toMatchObject({ detailPath: '/orders/4903' });
    expect(outcome.record.inverseOp).toEqual({ kind: 'ui', flow: 'orders.order.delete' });
  });

  it('reports the adapter’s own reason when the replay failed', async () => {
    const spy = dispatcher((job) => ({
      jobId: job.jobId,
      operation: job.operation,
      outcome: 'failed' as const,
      externalRef: null,
      detailPath: null,
      failureReason: 'POST /api/v2/orders answered 422',
      durationMs: 90,
    }));

    const adapter = createApiMaterializer({
      dispatcher: spy.dispatcher,
      reversalFor: () => REVERSAL,
    });

    const outcome = await adapter.materialize(node(), descriptor(), context());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.reason).toBe('POST /api/v2/orders answered 422');
  });
});

describe('reverting', () => {
  it('sends a DELETE at the path the inverse operation names', async () => {
    const spy = dispatcher((job) => created(job, ''));
    const adapter = createApiMaterializer({
      dispatcher: spy.dispatcher,
      reversalFor: () => REVERSAL,
    });

    const failure = await adapter.revert(
      { kind: 'api', method: 'DELETE', path: '/api/v2/orders/4903' },
      {
        tenantId: UUID,
        applicationId: UUID,
        memoryVersionId: UUID,
        entity: 'Order',
        externalRef: '4903',
        detailPath: null,
        deadlineMs: 5_000,
      },
    );

    expect(failure).toBeNull();
    const [job] = spy.jobs;
    expect(job?.operation).toBe('api_revert');
    if (job?.operation !== 'api_revert') return;
    expect(job.path).toBe('/api/v2/orders/4903');
  });

  it('declines an inverse operation belonging to another adapter', async () => {
    const adapter = createApiMaterializer({
      dispatcher: dispatcher(created).dispatcher,
      reversalFor: () => REVERSAL,
    });

    const failure = await adapter.revert(
      { kind: 'ui', flow: 'orders.order.delete' },
      {
        tenantId: UUID,
        applicationId: UUID,
        memoryVersionId: UUID,
        entity: 'Order',
        externalRef: '4903',
        detailPath: '/orders/4903',
        deadlineMs: 5_000,
      },
    );

    expect(failure?.reason).toContain('cannot run a ui inverse operation');
  });
});
