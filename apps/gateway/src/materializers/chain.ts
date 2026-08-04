import type {
  CompositionNode,
  CompositionPlan,
  EntitySchema,
  MaterializationAttempt,
  MaterializationResult,
  MaterializedRecord,
  MaterializerDescriptor,
  MaterializerKind,
} from 'protocol';

import type { MaterializationContext, MaterializedNode, Materializer } from './types.js';

/**
 * The fallback chain: fixture → api → ui → surface the failure with a concrete reason.
 *
 * docs/TEST-DATA-ENGINE.md § 4. Two rules govern everything here, and both exist because the
 * tester's conclusion about what they tested depends on them:
 *
 * 1. **Never silently degrade.** Every rung is recorded — the ones that succeeded, the ones that
 *    failed, and the ones that were skipped before they ran, each with its reason. If the API
 *    adapter was tried and the UI adapter is what created the record, the tester exercised
 *    different code than they would have otherwise, and the ledger has to show it.
 * 2. **An unverified materializer may not run ahead of the UI.** Verification has a TTL, and a
 *    replay that has not been proven in N days is a replay that may quietly create nothing.
 *    Demotion rather than exclusion: it still runs, just after the adapter that cannot be stale.
 *
 * ## Phase 15 ships one adapter, and the chain is still a chain
 *
 * Only the UI adapter is registered today; the API and fixture adapters are Phase 16. That makes
 * this, for now, a chain of one — but the ordering, the demotion rule and the attempt log are all
 * exercised by it, and the alternative (a direct call, retrofitted into a chain later) is how the
 * "which adapter ran" question ends up being answered from memory.
 *
 * ## Ordering a plan, not just an adapter
 *
 * The plan carries `materializationOrder`, topologically sorted, so a referenced record exists
 * before the record that points at it. The chain walks it in that order and threads each created
 * identifier forward, which is what makes "a customer with an overdue invoice" produce an Account
 * and then an Invoice that actually points at it.
 */

export interface ChainOptions {
  readonly materializers: readonly Materializer[];
  /** Entity schemas of the memory version, by id — the source of each node's descriptors. */
  readonly schemas: ReadonlyMap<string, EntitySchema>;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly applicationId: string;
  readonly memoryVersionId: string;
  /** Budget for one node. A plan of three nodes may take three times this. */
  readonly nodeDeadlineMs: number;
  /** Evaluation time, supplied so a verification TTL decision is reproducible in a test. */
  readonly now: Date;
}

/** One created record, paired with the node it came from, for the ledger. */
export interface ChainRecord {
  readonly node: CompositionNode;
  readonly adapter: MaterializerKind;
  readonly record: MaterializedNode;
}

export interface ChainOutcome {
  readonly result: MaterializationResult;
  /** In materialization order. Empty when the chain failed before creating anything. */
  readonly records: readonly ChainRecord[];
}

/**
 * Order an entity's materializers, demoting any whose verification has lapsed.
 *
 * The UI adapter is the fixed point of the ordering: it cannot be stale, because there is nothing
 * to verify — driving the real form *is* the proof. Everything unverified sorts after it.
 */
export function orderDescriptors(
  descriptors: readonly MaterializerDescriptor[],
  now: Date,
): readonly MaterializerDescriptor[] {
  const uiPriority = descriptors.find((descriptor) => descriptor.spec.kind === 'ui')?.priority;

  return [...descriptors].sort((left, right) => {
    const leftPriority = effectivePriority(left, now, uiPriority);
    const rightPriority = effectivePriority(right, now, uiPriority);
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return left.priority - right.priority;
  });
}

/** Whether a descriptor's verification is missing or older than its TTL. */
export function isStale(descriptor: MaterializerDescriptor, now: Date): boolean {
  // The UI adapter has nothing to verify: it drives the application's own form and asserts the
  // result is reachable, every time it runs. Treating it as stale would demote the one adapter
  // that is always available below the ones that might not work.
  if (descriptor.spec.kind === 'ui') return false;
  if (descriptor.verifiedAt === null) return true;

  const ageHours = (now.getTime() - Date.parse(descriptor.verifiedAt)) / 3_600_000;
  return ageHours > descriptor.verificationTtlHours;
}

function effectivePriority(
  descriptor: MaterializerDescriptor,
  now: Date,
  uiPriority: number | undefined,
): number {
  if (!isStale(descriptor, now)) return descriptor.priority;
  // Just after the UI adapter, or last when the entity has no UI adapter to sit behind.
  return (uiPriority ?? descriptor.priority) + 1;
}

/** Why a stale descriptor was demoted, in the words the ledger and the HUD will show. */
function stalenessReason(descriptor: MaterializerDescriptor, now: Date): string {
  if (descriptor.verifiedAt === null) {
    return `the ${descriptor.spec.kind} materializer has never been verified`;
  }
  const days = Math.floor((now.getTime() - Date.parse(descriptor.verifiedAt)) / 86_400_000);
  return `the ${descriptor.spec.kind} materializer has not been verified in ${String(days)} days`;
}

/**
 * Run a whole plan through the chain.
 *
 * Stops at the first node no adapter could create. A partially materialized graph is not a
 * failure to be retried blindly — the records that *were* created exist, are in the returned
 * records for the caller to write to the ledger, and are revertible. Pressing on to create the
 * dependent nodes of a node that does not exist would produce rows pointing at nothing.
 */
export async function runChain(
  plan: CompositionPlan,
  options: ChainOptions,
): Promise<ChainOutcome> {
  const startedAt = Date.now();
  const attempts: MaterializationAttempt[] = [];
  const records: ChainRecord[] = [];
  const created = new Map<string, string>();
  const materialized: MaterializedRecord[] = [];

  let adapterUsed: MaterializerKind | null = null;
  let failureReason: string | null = null;

  for (const nodeId of plan.materializationOrder) {
    const node = plan.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (node === undefined) {
      failureReason = `the plan's materialization order names ${nodeId}, which is not one of its nodes`;
      break;
    }

    // A reused record already exists. Nothing is created, nothing is attempted, and its own
    // identifier is what dependent nodes point at.
    if (node.mode === 'reuse_existing') {
      if (node.existingExternalRef !== null) created.set(node.nodeId, node.existingExternalRef);
      continue;
    }

    const outcome = await materializeNode(node, options, { plan, created });
    attempts.push(...outcome.attempts);

    if (outcome.record === null) {
      failureReason =
        outcome.reason ?? `no adapter could create the ${node.entity} this plan asked for`;
      break;
    }

    adapterUsed = outcome.adapter;
    created.set(node.nodeId, outcome.record.externalRef);
    records.push({ node, adapter: outcome.adapter, record: outcome.record });
    materialized.push({
      nodeId: node.nodeId,
      entity: node.entity,
      externalRef: outcome.record.externalRef,
      payload: outcome.record.payload,
      inverseOp: outcome.record.inverseOp,
    });
  }

  const succeeded = failureReason === null;

  return {
    records,
    result: {
      planId: plan.id,
      outcome: succeeded ? 'created' : 'failed',
      adapterUsed,
      // Never empty: a plan of only reused nodes still records that nothing needed creating,
      // because `MaterializationResult` requires the chain to be auditable either way.
      attempts:
        attempts.length > 0
          ? attempts
          : [
              {
                adapter: 'ui',
                outcome: 'skipped',
                reason: 'every record in the plan already existed',
                durationMs: 0,
              },
            ],
      records: materialized,
      // The adapters verify as they go — the UI adapter asserts the record is reachable before it
      // reports success — so a created outcome is a verified one. An adapter that could not
      // verify reports a failure instead of a record.
      verifiedAt: succeeded ? new Date().toISOString() : null,
      failureReason,
      durationMs: Date.now() - startedAt,
    },
  };
}

interface NodeOutcome {
  readonly attempts: readonly MaterializationAttempt[];
  readonly record: MaterializedNode | null;
  readonly adapter: MaterializerKind;
  readonly reason: string | null;
}

async function materializeNode(
  node: CompositionNode,
  options: ChainOptions,
  state: { readonly plan: CompositionPlan; readonly created: ReadonlyMap<string, string> },
): Promise<NodeOutcome> {
  const attempts: MaterializationAttempt[] = [];
  const schema = options.schemas.get(node.entitySchemaId);

  if (schema === undefined) {
    return {
      attempts,
      record: null,
      adapter: 'ui',
      reason: `no learned schema for ${node.entity} in this memory version`,
    };
  }

  const descriptors = orderDescriptors(schema.materializers, options.now);
  if (descriptors.length === 0) {
    return {
      attempts,
      record: null,
      adapter: 'ui',
      reason: `${node.entity} has no materializer — nothing in this application creates one`,
    };
  }

  const context: MaterializationContext = {
    tenantId: options.tenantId,
    sessionId: options.sessionId,
    applicationId: options.applicationId,
    memoryVersionId: options.memoryVersionId,
    plan: state.plan,
    created: state.created,
    deadlineMs: options.nodeDeadlineMs,
  };

  for (const descriptor of descriptors) {
    const adapter = options.materializers.find(
      (candidate) => candidate.kind === descriptor.spec.kind,
    );

    if (adapter === undefined) {
      attempts.push({
        adapter: descriptor.spec.kind,
        outcome: 'skipped',
        reason: `the ${descriptor.spec.kind} adapter is not available in this build`,
        durationMs: 0,
      });
      continue;
    }

    const refusal = adapter.canHandle(node, descriptor);
    if (refusal !== null) {
      attempts.push({
        adapter: descriptor.spec.kind,
        outcome: 'skipped',
        reason: refusal.reason,
        durationMs: 0,
      });
      continue;
    }

    // Recorded before the attempt, so a demotion is visible even when the demoted adapter then
    // succeeds. "It worked, and it was running unverified" is worth knowing.
    if (isStale(descriptor, options.now)) {
      attempts.push({
        adapter: descriptor.spec.kind,
        outcome: 'skipped',
        reason: `${stalenessReason(descriptor, options.now)}, so it ran after the UI adapter`,
        durationMs: 0,
      });
    }

    const startedAt = Date.now();
    const outcome = await adapter.materialize(node, descriptor, context);
    const durationMs = Date.now() - startedAt;

    if (outcome.ok) {
      attempts.push({
        adapter: adapter.kind,
        outcome: 'succeeded',
        reason: null,
        durationMs,
      });
      return { attempts, record: outcome.record, adapter: adapter.kind, reason: null };
    }

    attempts.push({
      adapter: adapter.kind,
      outcome: 'failed',
      reason: outcome.failure.reason,
      durationMs,
    });
  }

  const last = attempts.at(-1);
  return {
    attempts,
    record: null,
    adapter: 'ui',
    reason:
      last?.reason ?? `every adapter for ${node.entity} declined to create it, without saying why`,
  };
}
