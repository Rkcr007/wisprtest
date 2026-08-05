import type {
  CompositionNode,
  CompositionPlan,
  MaterializerDescriptor,
  SeedJob,
  SeedJobResult,
} from 'protocol';
import { describe, expect, it } from 'vitest';

import type { SeedJobDispatcher } from '../redis/seed-queue.js';
import { createFixtureMaterializer } from './fixture.js';
import type { MaterializationContext } from './types.js';

/**
 * The fixture adapter, and the one refusal that matters most in it.
 *
 * `MaterializerSpec` types `command` as a free string and § 4 describes the adapter as an
 * "endpoint, factory, or SQL". Two of those three readings are arbitrary code execution driven by
 * a database column, so this implementation is the endpoint reading only — and the test that says
 * so is the one that would notice if somebody later made `command` do more.
 */

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function descriptor(command: string): MaterializerDescriptor {
  return {
    id: UUID,
    entitySchemaId: UUID,
    spec: { kind: 'fixture', command },
    priority: 0,
    verifiedAt: new Date().toISOString(),
    verificationTtlHours: 168,
  };
}

const NODE: CompositionNode = {
  nodeId: 'order-1',
  entity: 'Order',
  entitySchemaId: UUID,
  mode: 'create',
  existingExternalRef: null,
  fields: { customer: 'Acme Industrial', status: 'pending' },
  provenance: [],
};

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

function dispatcher(): { readonly jobs: SeedJob[]; readonly dispatcher: SeedJobDispatcher } {
  const jobs: SeedJob[] = [];
  return {
    jobs,
    dispatcher: {
      run: async (job): Promise<SeedJobResult> => {
        jobs.push(job);
        return await Promise.resolve({
          jobId: job.jobId,
          operation: job.operation,
          outcome: 'succeeded' as const,
          externalRef: job.operation.endsWith('_create') ? '4903' : null,
          detailPath: null,
          failureReason: null,
          durationMs: 40,
        });
      },
    },
  };
}

describe('what a configured command is allowed to be', () => {
  const adapter = createFixtureMaterializer({
    dispatcher: dispatcher().dispatcher,
    teardownFor: () => null,
  });

  it('accepts a path on the application’s own origin', () => {
    expect(adapter.canHandle(NODE, descriptor('/__seed/orders'))).toBeNull();
  });

  it('accepts an absolute https endpoint', () => {
    expect(adapter.canHandle(NODE, descriptor('https://staging.example.com/__seed'))).toBeNull();
  });

  it('refuses a shell command', () => {
    // The refusal that stops `command` from being remote code execution reachable through
    // configuration. A customer whose seeder is a rake task cannot use this adapter, and the
    // reason says so rather than the chain failing opaquely three services away.
    const refusal = adapter.canHandle(NODE, descriptor('rake db:seed:order'));

    expect(refusal?.reason).toContain('not an http(s) endpoint');
    expect(refusal?.reason).toContain('will not run a shell command');
  });

  it('refuses a SQL statement', () => {
    const refusal = adapter.canHandle(NODE, descriptor('INSERT INTO orders (id) VALUES (1)'));
    expect(refusal?.reason).toContain('not an http(s) endpoint');
  });

  it('refuses a non-http scheme', () => {
    expect(adapter.canHandle(NODE, descriptor('file:///etc/passwd'))?.reason).toContain(
      'not an http(s) endpoint',
    );
  });
});

describe('creating through the configured endpoint', () => {
  it('posts the composed record to the command', async () => {
    const spy = dispatcher();
    const adapter = createFixtureMaterializer({
      dispatcher: spy.dispatcher,
      teardownFor: () => null,
    });

    const outcome = await adapter.materialize(NODE, descriptor('/__seed/orders'), context());

    expect(outcome.ok).toBe(true);
    const [job] = spy.jobs;
    expect(job?.operation).toBe('fixture_create');
    if (job?.operation !== 'fixture_create') return;
    expect(job.command).toBe('/__seed/orders');
    expect(job.payload).toEqual({ customer: 'Acme Industrial', status: 'pending' });
  });

  it('resolves a reference to the identifier the referenced node got', async () => {
    const spy = dispatcher();
    const adapter = createFixtureMaterializer({
      dispatcher: spy.dispatcher,
      teardownFor: () => null,
    });

    await adapter.materialize(
      { ...NODE, fields: { ...NODE.fields, accountId: 'account-node' } },
      descriptor('/__seed/orders'),
      context(new Map([['account-node', 'ACC-9001']])),
    );

    const [job] = spy.jobs;
    if (job?.operation !== 'fixture_create') throw new Error('no fixture job was dispatched');
    expect(job.payload).toMatchObject({ accountId: 'ACC-9001' });
  });

  it('says a record cannot be removed when no teardown is configured', async () => {
    const adapter = createFixtureMaterializer({
      dispatcher: dispatcher().dispatcher,
      teardownFor: () => null,
    });

    const outcome = await adapter.materialize(NODE, descriptor('/__seed/orders'), context());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // § 5's honest answer. The alternative — guessing a teardown URL and posting at a customer's
    // infrastructure — is worse than telling the tester up front.
    expect(outcome.record.inverseOp.kind).toBe('none');
    if (outcome.record.inverseOp.kind !== 'none') return;
    expect(outcome.record.inverseOp.reason).toContain('no teardown command is configured');
  });

  it('names the configured teardown when there is one', async () => {
    const adapter = createFixtureMaterializer({
      dispatcher: dispatcher().dispatcher,
      teardownFor: () => '/__seed/orders/teardown',
    });

    const outcome = await adapter.materialize(NODE, descriptor('/__seed/orders'), context());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.inverseOp).toEqual({
      kind: 'fixture',
      command: '/__seed/orders/teardown',
    });
  });
});

describe('reverting through the configured teardown', () => {
  it('posts the entity and identifier the endpoint needs', async () => {
    const spy = dispatcher();
    const adapter = createFixtureMaterializer({
      dispatcher: spy.dispatcher,
      teardownFor: () => '/__seed/orders/teardown',
    });

    const failure = await adapter.revert(
      { kind: 'fixture', command: '/__seed/orders/teardown' },
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
    expect(job?.operation).toBe('fixture_revert');
    if (job?.operation !== 'fixture_revert') return;
    expect(job.externalRef).toBe('4903');
    expect(job.entity).toBe('Order');
  });

  it('refuses a teardown that is not an endpoint, rather than executing it', async () => {
    const adapter = createFixtureMaterializer({
      dispatcher: dispatcher().dispatcher,
      teardownFor: () => 'rake db:teardown',
    });

    const failure = await adapter.revert(
      { kind: 'fixture', command: 'rake db:teardown' },
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

    expect(failure?.reason).toContain('removed by hand');
  });
});
