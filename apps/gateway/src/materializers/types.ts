import type {
  CompositionNode,
  CompositionPlan,
  InverseOperation,
  MaterializerDescriptor,
  MaterializerKind,
} from 'protocol';

/**
 * The materializer interface, as docs/TEST-DATA-ENGINE.md § 4 states it.
 *
 * One adapter, one way of writing a record into the application under test. The plan says *what*
 * to create; an adapter decides *how*, and the chain in `chain.ts` decides which one gets to try.
 *
 * ## Node at a time, not plan at a time
 *
 * § 4 writes the signature as `materialize(plan, ctx)`. This takes a node instead, and the
 * difference is not cosmetic: a plan is a DAG, its nodes are materialized in dependency order,
 * and a referenced record's identifier is only known once the node that creates it has run.
 * Handing an adapter the whole plan would either make every adapter reimplement that ordering, or
 * quietly limit the system to single-record plans — which § 3 is explicit is a rewrite to undo.
 *
 * ## Adapters do not decide policy
 *
 * Whether seeding is permitted, whether a human approved it, and what goes in the ledger are the
 * route's business. An adapter that reaches this interface has already been cleared to write.
 */

/** What an adapter is told about the record it is creating. */
export interface MaterializationContext {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly applicationId: string;
  readonly memoryVersionId: string;
  readonly plan: CompositionPlan;
  /**
   * Identifiers of nodes already created in this run, by plan-local node id.
   *
   * How a dependency edge is honoured: the Invoice node's `account` field holds the plan-local id
   * of the Account node until the Account exists, and this is where its real identifier appears.
   */
  readonly created: ReadonlyMap<string, string>;
  /** Wall-clock budget for this one node. */
  readonly deadlineMs: number;
}

/** What an adapter produces when it succeeds. */
export interface MaterializedNode {
  /** The application's own identifier for the record. */
  readonly externalRef: string;
  /** What was actually sent, for the ledger. Redacted of nothing — it is the composed record. */
  readonly payload: unknown;
  /** How to undo this, decided now that the record has an identifier. */
  readonly inverseOp: InverseOperation;
}

/** Why an adapter could not, or would not, run. */
export interface MaterializationRefusal {
  readonly reason: string;
}

export type MaterializationOutcome =
  | { readonly ok: true; readonly record: MaterializedNode }
  | { readonly ok: false; readonly failure: MaterializationRefusal };

export interface Materializer {
  readonly kind: MaterializerKind;

  /**
   * Whether this adapter can create this node at all.
   *
   * Separate from `materialize` because the chain reports a skip differently from a failure: an
   * adapter that was never applicable did not degrade anything, while one that tried and failed
   * changed what the test covered and has to be shown to the tester (§ 4).
   */
  canHandle(
    node: CompositionNode,
    descriptor: MaterializerDescriptor,
  ): MaterializationRefusal | null;

  materialize(
    node: CompositionNode,
    descriptor: MaterializerDescriptor,
    context: MaterializationContext,
  ): Promise<MaterializationOutcome>;

  /** Undo one record. Returns the failure reason, or null on success. */
  revert(
    inverseOp: InverseOperation,
    context: RevertContext,
  ): Promise<MaterializationRefusal | null>;
}

/** What an adapter is told when undoing a record. */
export interface RevertContext {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly memoryVersionId: string;
  readonly entity: string;
  readonly externalRef: string;
  /** Where the record lives, as read back when it was created. See `SeedJob`'s revert variant. */
  readonly detailPath: string | null;
  readonly deadlineMs: number;
}
