import {
  RuntimeState,
  SeedExecuteResponse,
  SeedPlanResponse,
  SeedRevertResponse,
  type MaterializationResult,
  type SeedLedgerEntry,
  type SeedRevertOutcome,
} from 'protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  createSeedController,
  type SeedController,
  type SeedExecuteOutcome,
  type SeedPlanOutcome,
  type SeedRevertResult,
  type SeedTransport,
} from './controller.js';

/**
 * The class-S guarantees, pinned down.
 *
 * CLAUDE.md § "Reversibility taxonomy" puts seeding in the same never-speculative column as a
 * committing action, and docs/TEST-DATA-ENGINE.md § 6 adds the part specific to seeding: the
 * confirmation happens against a preview, so what a tester approves is what gets written.
 *
 * The tests that matter here are the ones that assert something *did not happen* — the transport's
 * `execute` was never called. `execute` is the only method in the whole extension that can create a
 * record in a customer's application, so a spy on it that stays at zero calls is the strongest
 * statement this suite can make. Everything else is a rendering detail by comparison.
 */

const UUID_PLAN = '11111111-1111-4111-8111-111111111111';
const UUID_TENANT = '22222222-2222-4222-8222-222222222222';
const UUID_SESSION = '33333333-3333-4333-8333-333333333333';
const UUID_MEMORY = '44444444-4444-4444-8444-444444444444';
const UUID_SCHEMA = '55555555-5555-4555-8555-555555555555';
const UUID_LEDGER_A = '66666666-6666-4666-8666-666666666666';
const UUID_LEDGER_B = '77777777-7777-4777-8777-777777777777';

const NOW = '2026-08-04T12:00:00.000Z';
const EXPIRES = '2026-08-04T12:05:00.000Z';

/** Parsed through the contract, so a fixture that drifted from the schema fails here, not later. */
const RUNTIME_STATE: RuntimeState = RuntimeState.parse({
  route: '/orders',
  routePattern: '/orders',
  modalStack: [],
  focusedLandmark: null,
  visibleElementKeys: ['orders.list.row'],
  structuralHash: 'a'.repeat(64),
  stateFingerprint: 'b'.repeat(64),
  capturedAt: NOW,
});

const CONSTRAINT_SET = {
  entity: 'Order',
  constraints: [{ kind: 'equals' as const, field: 'status', value: 'Pending' }],
  unparsedFragments: [],
  confidence: 0.94,
};

function planResponse(overrides: Partial<Record<string, unknown>> = {}): SeedPlanResponse {
  return SeedPlanResponse.parse({
    composition: {
      constraintSet: CONSTRAINT_SET,
      outcome: {
        kind: 'planned',
        plan: {
          id: UUID_PLAN,
          tenantId: UUID_TENANT,
          sessionId: UUID_SESSION,
          memoryVersionId: UUID_MEMORY,
          rootNodeId: 'order-1',
          nodes: [
            {
              nodeId: 'order-1',
              entity: 'Order',
              entitySchemaId: UUID_SCHEMA,
              mode: 'create',
              existingExternalRef: null,
              fields: { status: 'Pending', amount: 4200 },
              provenance: [
                {
                  field: 'status',
                  value: 'Pending',
                  source: 'requested',
                  explanation: 'you asked for a pending order',
                  confidence: 1,
                },
                {
                  field: 'amount',
                  value: 4200,
                  source: 'sampled',
                  explanation: 'sampled from 312 observed orders (median 3,980)',
                  confidence: 0.82,
                },
              ],
            },
          ],
          edges: [],
          materializationOrder: ['order-1'],
          constraintSet: CONSTRAINT_SET,
          createdAt: NOW,
        },
        aliasWriteBacks: [],
      },
      parseTier: 'T0',
      durationMs: 180,
    },
    planId: UUID_PLAN,
    preview: [
      {
        nodeId: 'order-1',
        entity: 'Order',
        mode: 'create',
        adapter: 'ui',
        adapterReason: 'no API materializer was observed, so the real create form will run',
        revert: {
          revertible: true,
          kind: 'ui',
          detail: 'drives the indexed delete flow on /orders/:id',
        },
      },
    ],
    expiresAt: EXPIRES,
    ...overrides,
  });
}

const CONFLICT_RESPONSE: SeedPlanResponse = SeedPlanResponse.parse({
  composition: {
    constraintSet: CONSTRAINT_SET,
    outcome: {
      kind: 'conflict',
      constraintSet: CONSTRAINT_SET,
      conflict: {
        left: {
          kind: 'constraint',
          constraint: { kind: 'comparison', field: 'amount', op: 'gt', value: 50000 },
        },
        right: {
          kind: 'constraint',
          constraint: { kind: 'comparison', field: 'amount', op: 'lt', value: 1000 },
        },
        field: 'amount',
        explanation: 'amount cannot be both over 50,000 and under 1,000',
      },
    },
    parseTier: 'T0',
    durationMs: 90,
  },
  planId: null,
  preview: [],
  expiresAt: null,
});

function ledgerEntry(id: string, externalRef: string): SeedLedgerEntry {
  return {
    id,
    tenantId: UUID_TENANT,
    sessionId: UUID_SESSION,
    planId: UUID_PLAN,
    nodeId: 'order-1',
    entitySchemaId: UUID_SCHEMA,
    entity: 'Order',
    externalRef,
    adapterUsed: 'ui',
    payload: { status: 'Pending' },
    provenance: [],
    inverseOp: { kind: 'ui', flow: 'orders.detail.delete' },
    createdAt: NOW,
    revertedAt: null,
  };
}

function executeResponse(outcome: 'created' | 'failed' = 'created'): SeedExecuteResponse {
  const result: MaterializationResult = {
    planId: UUID_PLAN,
    outcome,
    adapterUsed: outcome === 'created' ? 'ui' : null,
    attempts: [
      {
        adapter: 'ui',
        outcome: outcome === 'created' ? 'succeeded' : 'failed',
        reason: outcome === 'created' ? null : 'the create form rejected the amount field',
        durationMs: 4200,
      },
    ],
    records:
      outcome === 'created'
        ? [
            {
              nodeId: 'order-1',
              entity: 'Order',
              externalRef: 'ORD-4903',
              payload: { status: 'Pending' },
              inverseOp: { kind: 'ui', flow: 'orders.detail.delete' },
            },
          ]
        : [],
    verifiedAt: outcome === 'created' ? NOW : null,
    failureReason: outcome === 'created' ? null : 'the create form rejected the amount field',
    durationMs: 4300,
  };
  return SeedExecuteResponse.parse({
    result,
    ledger: outcome === 'created' ? [ledgerEntry(UUID_LEDGER_A, 'ORD-4903')] : [],
  });
}

interface Harness {
  readonly controller: SeedController;
  readonly plan: ReturnType<typeof vi.fn>;
  readonly execute: ReturnType<typeof vi.fn>;
  readonly revert: ReturnType<typeof vi.fn>;
}

function harness(
  overrides: {
    plan?: () => Promise<SeedPlanOutcome>;
    execute?: () => Promise<SeedExecuteOutcome>;
    revert?: () => Promise<SeedRevertResult>;
    now?: () => Date;
  } = {},
): Harness {
  const plan = vi.fn(
    overrides.plan ?? (() => Promise.resolve({ ok: true, response: planResponse() })),
  );
  const execute = vi.fn(
    overrides.execute ??
      (() =>
        Promise.resolve({
          ok: true,
          result: executeResponse().result,
          ledger: executeResponse().ledger,
        })),
  );
  const revert = vi.fn(overrides.revert ?? (() => Promise.resolve({ ok: true, outcomes: [] })));

  const transport = { plan, execute, revert } as unknown as SeedTransport;
  const controller = createSeedController({
    transport,
    wallClock: overrides.now ?? (() => new Date(NOW)),
  });
  return { controller, plan, execute, revert };
}

describe('composing a plan', () => {
  it('writes nothing — the plan call is a read, and execute is never reached', async () => {
    const { controller, plan, execute } = harness();

    await controller.plan('I need a pending order', RUNTIME_STATE);

    expect(plan).toHaveBeenCalledTimes(1);
    // The assertion this whole module exists for.
    expect(execute).not.toHaveBeenCalled();
    expect(controller.view.value.phase).toBe('previewing');
  });

  it('renders every field with the explanation the composer gave it', async () => {
    const { controller } = harness();
    await controller.plan('I need a pending order', RUNTIME_STATE);

    const node = controller.view.value.nodes[0];
    expect(node?.entity).toBe('Order');
    expect(node?.adapter).toBe('ui');
    expect(node?.revertible).toBe(true);
    expect(node?.fields.map((field) => field.field)).toEqual(['status', 'amount']);
    // Verbatim. § 3: "matched from 64 known accounts", not "generated".
    expect(node?.fields[1]?.explanation).toBe('sampled from 312 observed orders (median 3,980)');
  });

  it('surfaces a conflict as an answer with nothing to approve', async () => {
    const { controller, execute } = harness({
      plan: () => Promise.resolve({ ok: true, response: CONFLICT_RESPONSE }),
    });

    await controller.plan('an order over 50,000 and under 1,000', RUNTIME_STATE);
    expect(controller.view.value.phase).toBe('answered');
    expect(controller.view.value.answer).toBe('amount cannot be both over 50,000 and under 1,000');

    // There is no held plan behind a conflict, so a confirmation cannot reach the gateway.
    await controller.approve();
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports a policy refusal as something the tester cannot retry away', async () => {
    const { controller } = harness({
      plan: () =>
        Promise.resolve({
          ok: false,
          reason: 'forbidden',
          detail: 'seeding is not enabled for this production application',
        }),
    });

    await controller.plan('I need an order', RUNTIME_STATE);
    expect(controller.view.value.phase).toBe('failed');
    expect(controller.view.value.error).toContain('seeding is not enabled');
  });
});

describe('approval', () => {
  it('is the only path to a write, and sends back the id it was given', async () => {
    const { controller, execute } = harness();
    await controller.plan('I need a pending order', RUNTIME_STATE);

    await controller.approve();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ planId: UUID_PLAN, approvedAt: NOW });
    expect(controller.view.value.phase).toBe('executed');
    expect(controller.view.value.ledger[0]?.externalRef).toBe('ORD-4903');
  });

  it('does nothing at all when no plan has been previewed', async () => {
    const { controller, execute } = harness();

    // No `plan()` first. A stray confirmation with no card on screen must not write.
    await controller.approve();

    expect(execute).not.toHaveBeenCalled();
    expect(controller.view.value.phase).toBe('idle');
  });

  it('turns one yes into exactly one record, however many times it is clicked', async () => {
    const { controller, execute } = harness();
    await controller.plan('I need a pending order', RUNTIME_STATE);

    // A double-clicked button, or two approvals racing each other.
    await Promise.all([controller.approve(), controller.approve()]);
    await controller.approve();

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('refuses a lapsed plan rather than writing against stale memory', async () => {
    const afterExpiry = new Date('2026-08-04T12:05:01.000Z');
    const { controller, execute } = harness({ now: () => afterExpiry });

    await controller.plan('I need a pending order', RUNTIME_STATE);
    await controller.approve();

    expect(execute).not.toHaveBeenCalled();
    expect(controller.view.value.phase).toBe('failed');
    expect(controller.view.value.error).toContain('expired');
  });

  it('drops the held plan when the card is dismissed', async () => {
    const { controller, execute } = harness();
    await controller.plan('I need a pending order', RUNTIME_STATE);

    controller.dismiss();
    await controller.approve();

    expect(execute).not.toHaveBeenCalled();
    expect(controller.view.value.phase).toBe('idle');
  });

  it('keeps the whole chain when materialization fails, rather than one flat error', async () => {
    const failed = executeResponse('failed');
    const { controller } = harness({
      execute: () => Promise.resolve({ ok: true, result: failed.result, ledger: failed.ledger }),
    });

    await controller.plan('I need a pending order', RUNTIME_STATE);
    await controller.approve();

    const view = controller.view.value;
    expect(view.phase).toBe('failed');
    // § 4 forbids silent degradation: every rung is kept, with the concrete reason it failed.
    expect(view.result?.attempts).toHaveLength(1);
    expect(view.result?.attempts[0]?.reason).toBe('the create form rejected the amount field');
    expect(view.ledger).toEqual([]);
  });
});

describe('a second utterance while the first is still composing', () => {
  it('abandons the earlier plan, so approval cannot land on a card that was replaced', async () => {
    const deferred: { settle: (outcome: SeedPlanOutcome) => void } = { settle: () => undefined };
    const first = new Promise<SeedPlanOutcome>((resolve) => {
      deferred.settle = resolve;
    });

    let call = 0;
    const { controller, execute } = harness({
      plan: () => {
        call += 1;
        return call === 1
          ? first
          : Promise.resolve({ ok: true, response: planResponse({ planId: UUID_PLAN }) });
      },
    });

    const pending = controller.plan('I need a pending order', RUNTIME_STATE);
    await controller.plan('I need an overdue invoice', RUNTIME_STATE);

    // The first response lands late. It must not overwrite the preview the tester is looking at.
    deferred.settle({ ok: true, response: CONFLICT_RESPONSE });
    await pending;

    expect(controller.view.value.phase).toBe('previewing');
    expect(controller.view.value.utterance).toBe('I need an overdue invoice');

    await controller.approve();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('reverting', () => {
  it('drops the entries that were removed and keeps the ones that were not', async () => {
    const outcomes: SeedRevertOutcome[] = [
      {
        ledgerEntryId: UUID_LEDGER_A,
        entity: 'Order',
        externalRef: 'ORD-4903',
        outcome: 'reverted',
        reason: null,
      },
      {
        ledgerEntryId: UUID_LEDGER_B,
        entity: 'Order',
        externalRef: 'ORD-4904',
        outcome: 'not_revertible',
        reason: 'no delete path was indexed for Order',
      },
    ];

    const { controller, revert } = harness({
      execute: () =>
        Promise.resolve({
          ok: true,
          result: executeResponse().result,
          ledger: [ledgerEntry(UUID_LEDGER_A, 'ORD-4903'), ledgerEntry(UUID_LEDGER_B, 'ORD-4904')],
        }),
      revert: () =>
        Promise.resolve(SeedRevertResponse.parse({ outcomes, durationMs: 900 })).then((parsed) => ({
          ok: true,
          outcomes: parsed.outcomes,
        })),
    });

    await controller.plan('I need two orders', RUNTIME_STATE);
    await controller.approve();
    expect(controller.view.value.ledger).toHaveLength(2);

    await controller.revertSession();

    expect(revert).toHaveBeenCalledWith({ scope: 'session' });
    // Partial success is normal: the removed one is gone from the ledger, the other stays because
    // it is still in the customer's application.
    expect(controller.view.value.ledger.map((entry) => entry.externalRef)).toEqual(['ORD-4904']);
    expect(controller.view.value.reverted).toHaveLength(2);
  });

  it('names one entry when reverting a single record', async () => {
    const { controller, revert } = harness();
    await controller.revertEntry(UUID_LEDGER_A);
    expect(revert).toHaveBeenCalledWith({ scope: 'entry', ledgerEntryId: UUID_LEDGER_A });
  });
});

describe('a transport that throws rather than resolving', () => {
  it('is contained — the HUD sees a failed card, not an unhandled rejection', async () => {
    const onError = vi.fn();
    const controller = createSeedController({
      transport: {
        plan: () => Promise.reject(new Error('the port went away')),
        execute: () => Promise.reject(new Error('unreachable')),
        revert: () => Promise.reject(new Error('unreachable')),
      },
      wallClock: () => new Date(NOW),
      onError,
    });

    await controller.plan('I need a pending order', RUNTIME_STATE);

    expect(controller.view.value.phase).toBe('failed');
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
