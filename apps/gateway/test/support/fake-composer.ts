import { randomUUID } from 'node:crypto';

import type {
  CompositionNode,
  CompositionPlan,
  CompositionRequest,
  CompositionResponse,
  ConstraintSet,
} from 'protocol';

import type { ComposerClient } from '../../src/composer/client.js';

/**
 * A composer that answers from a script.
 *
 * The real composer is a separate deployable with its own suite (`apps/composer`, Phase 14), and
 * its correctness is not what the seed routes are being asked about here. What *is* being asked
 * is whether the gateway does the right thing with each of the three answers the contract allows
 * — a plan, a conflict, a refusal — and a scripted composer is the only way to ask that question
 * about the conflict and the refusal at all: producing a genuine unsatisfiable constraint set
 * through a real composer would be a test of the solver wearing a route's clothes.
 *
 * The requests it receives are kept, so the suite can assert what the gateway sent — in
 * particular that the memory version came from the session and not from the caller.
 */

export interface FakeComposer extends ComposerClient {
  readonly requests: CompositionRequest[];
  /** Answer the next call with this. */
  reply(response: CompositionResponse): void;
  /** Fail the next call, as an unreachable composer would. */
  failWith(error: Error): void;
}

export function createFakeComposer(): FakeComposer {
  const requests: CompositionRequest[] = [];
  let next: CompositionResponse | null = null;
  let failure: Error | null = null;

  return {
    requests,

    reply(response: CompositionResponse): void {
      next = response;
      failure = null;
    },

    failWith(error: Error): void {
      failure = error;
      next = null;
    },

    async compose(request: CompositionRequest): Promise<CompositionResponse> {
      requests.push(request);
      await Promise.resolve();
      if (failure !== null) throw failure;
      if (next === null) throw new Error('the fake composer was called with no scripted reply');
      return next;
    },
  };
}

export const CONSTRAINT_SET: ConstraintSet = {
  entity: 'Order',
  constraints: [{ kind: 'equals', field: 'status', value: 'pending' }],
  confidence: 0.96,
  unparsedFragments: [],
};

export interface PlanFixtureOptions {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly memoryVersionId: string;
  readonly entitySchemaId: string;
  readonly nodes?: readonly CompositionNode[];
  readonly edges?: CompositionPlan['edges'];
  readonly materializationOrder?: readonly string[];
}

/** A one-node plan for `Order`, shaped exactly as the composer would return it. */
export function planFixture(options: PlanFixtureOptions): CompositionPlan {
  const nodes = options.nodes ?? [
    {
      nodeId: 'order-1',
      entity: 'Order',
      entitySchemaId: options.entitySchemaId,
      mode: 'create',
      existingExternalRef: null,
      fields: { customer: 'Composed Holdings', status: 'pending' },
      provenance: [
        {
          field: 'status',
          value: 'pending',
          source: 'requested',
          explanation: 'matched the enum value spoken as "pending"',
          confidence: 0.96,
        },
        {
          field: 'customer',
          value: 'Composed Holdings',
          source: 'sampled',
          explanation: 'drawn from the observed distribution of 50 customer names',
          confidence: 0.8,
        },
      ],
    },
  ];

  return {
    id: randomUUID(),
    tenantId: options.tenantId,
    sessionId: options.sessionId,
    memoryVersionId: options.memoryVersionId,
    rootNodeId: nodes[0]?.nodeId ?? 'order-1',
    nodes: [...nodes],
    edges: options.edges ?? [],
    materializationOrder: [...(options.materializationOrder ?? nodes.map((node) => node.nodeId))],
    constraintSet: CONSTRAINT_SET,
    createdAt: new Date().toISOString(),
  };
}

/** The `planned` response the composer returns for a plan. */
export function plannedResponse(plan: CompositionPlan): CompositionResponse {
  return {
    constraintSet: CONSTRAINT_SET,
    outcome: { kind: 'planned', plan, aliasWriteBacks: [] },
    parseTier: 'T0',
    durationMs: 41,
  };
}
