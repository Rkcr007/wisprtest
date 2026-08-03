import {
  EntitySchema as EntitySchemaContract,
  MaterializerSpec as MaterializerSpecContract,
  SeedLedgerEntry as SeedLedgerEntrySchema,
  type EntitySchema,
  type InverseOperation,
  type MaterializerKind,
  type ProvenanceEntry,
  type SeedLedgerEntry,
} from 'protocol';

import { GatewayError } from '../errors.js';
import type { ScopedDatabase } from './pool.js';

/**
 * The reads and writes behind the seed endpoints.
 *
 * Like the other repositories here, nothing writes a `where tenant_id = …`: row-level security
 * applies it, and a duplicated filter is one that can drift from the policy.
 *
 * ## What the composer is given, and what it is not
 *
 * `loadEntitySchemas` assembles the per-application knowledge a plan draws on — the entity's
 * fields, their learned distributions and vocabularies, its materializers and its predicates. All
 * of it is structure. None of it is content: the distributions are aggregates the observers
 * computed precisely so raw values never had to be stored (CLAUDE.md § "PII rule"), and the enum
 * vocabularies went through the redaction pipeline before they were written.
 */

/** The seeding policy for one application, as the database computes it. */
export interface SeedPolicy {
  readonly applicationId: string;
  readonly environment: string;
  /** The generated column. The rule lives in the migration, not here — see the comment there. */
  readonly allowed: boolean;
}

export async function findSeedPolicy(
  db: ScopedDatabase,
  applicationId: string,
): Promise<SeedPolicy | null> {
  const row = await db
    .selectFrom('applications')
    .select(['id', 'env', 'seedingAllowed'])
    .where('id', '=', applicationId)
    .executeTakeFirst();

  if (row === undefined) return null;

  return {
    applicationId: row.id,
    environment: row.env,
    // Nullable in the generated types because kysely-codegen cannot see that a stored generated
    // column is never null. Compared explicitly rather than coerced: if it ever *were* null, the
    // safe reading of "we do not know whether seeding is allowed" is that it is not.
    allowed: row.seedingAllowed === true,
  };
}

/**
 * Every entity schema in a memory version, with its fields, materializers and predicates.
 *
 * All of them, not just the one the utterance seems to be about. A plan is a graph — "a customer
 * with an overdue invoice" needs `Invoice` to know what overdue means and `Account` to hang it
 * on — and which entities that turns out to involve is the composer's conclusion, not the
 * gateway's. Filtering here would be the gateway making a parse decision it has no parser for.
 */
export interface LoadedSchemas {
  readonly schemas: readonly EntitySchema[];
  /**
   * The indexed delete control per entity name, for entities that have one.
   *
   * Kept beside the schemas rather than on them because `EntitySchema` is a contract shape and
   * this is not part of it — the inverse operation belongs to a *created record*, and this is the
   * per-application knowledge the adapter builds one from.
   */
  readonly deleteFlows: ReadonlyMap<string, string>;
}

export async function loadEntitySchemas(
  db: ScopedDatabase,
  memoryVersionId: string,
): Promise<LoadedSchemas> {
  const entities = await db
    .selectFrom('entitySchemas')
    .select([
      'id',
      'memoryVersionId',
      'entityName',
      'observedCount',
      'confidence',
      'createdAt',
      'deleteFlowElementKey',
    ])
    .where('memoryVersionId', '=', memoryVersionId)
    .orderBy('entityName')
    .execute();

  if (entities.length === 0) return { schemas: [], deleteFlows: new Map() };

  const entityIds = entities.map((entity) => entity.id);

  const fields = await db
    .selectFrom('fieldSpecs')
    .selectAll()
    .where('entitySchemaId', 'in', entityIds)
    .orderBy('name')
    .execute();

  const materializers = await db
    .selectFrom('materializers')
    .selectAll()
    .where('entitySchemaId', 'in', entityIds)
    .orderBy('priority')
    .execute();

  const deleteFlows = new Map<string, string>();
  for (const entity of entities) {
    if (entity.deleteFlowElementKey !== null) {
      deleteFlows.set(entity.entityName, entity.deleteFlowElementKey);
    }
  }

  const schemas = entities.map((entity) => {
    const parsed = EntitySchemaContract.safeParse({
      id: entity.id,
      memoryVersionId: entity.memoryVersionId,
      entityName: entity.entityName,
      // Built as plain objects and validated by the parse below rather than annotated on the way
      // in: these columns are `jsonb`, so the driver hands back `JsonValue`, and asserting them
      // into their contract types here would move the check from runtime to a cast that cannot
      // fail. The parse is the check.
      fields: fields
        .filter((field) => field.entitySchemaId === entity.id)
        .map((field) => ({
          id: field.id,
          entitySchemaId: field.entitySchemaId,
          name: field.name,
          type: field.type,
          required: field.required,
          valueConstraints: field.valueConstraints,
          enumValues: field.enumValues,
          distribution: field.distribution,
          derivedRule: field.derivedRule,
          referencesEntity: field.referencesEntity,
          controlElementKey: field.controlElementKey,
          unique: field.isUnique,
        })),
      materializers: materializers
        .filter((materializer) => materializer.entitySchemaId === entity.id)
        .map((materializer) => ({
          id: materializer.id,
          entitySchemaId: materializer.entitySchemaId,
          spec: MaterializerSpecContract.parse(materializer.spec),
          priority: materializer.priority,
          verifiedAt: materializer.verifiedAt?.toISOString() ?? null,
          verificationTtlHours: materializer.verificationTtlHours,
        })),
      // Predicates are learned by the console's definition surface and by drift reconciliation,
      // neither of which exists yet. An empty list is the honest statement that this application
      // has none — not a placeholder, and the solver reads it as "no predicate is satisfiable",
      // which is exactly right until one is defined.
      predicates: [],
      observedCount: entity.observedCount,
      confidence: Number(entity.confidence),
      createdAt: entity.createdAt.toISOString(),
    });

    if (!parsed.success) {
      // A stored schema that does not match the contract is a broken row, not a broken request.
      // Named rather than left as a raw parse failure: the alternative is a 500 whose only clue is
      // a Zod path, on a route whose most likely cause is an entity written by an older observer.
      throw new GatewayError('internal', 'a stored entity schema does not match the contract', {
        entity: entity.entityName,
        memoryVersionId,
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
      });
    }

    return parsed.data;
  });

  return { schemas, deleteFlows };
}

/** What a session is allowed to seed against: its application, and the memory it resolved with. */
export interface SessionScope {
  readonly sessionId: string;
  readonly applicationId: string;
  readonly memoryVersionId: string;
  readonly open: boolean;
}

/**
 * The application and memory version a session belongs to.
 *
 * Read rather than accepted from the request: a plan composed against one memory version and
 * materialized against another would fill a form that no longer exists, and the caller has no
 * reason to be able to express that.
 */
export async function findSessionScope(
  db: ScopedDatabase,
  sessionId: string,
): Promise<SessionScope | null> {
  const row = await db
    .selectFrom('sessions')
    .select(['id', 'applicationId', 'memoryVersionId', 'endedAt'])
    .where('id', '=', sessionId)
    .executeTakeFirst();

  if (row === undefined) return null;

  return {
    sessionId: row.id,
    applicationId: row.applicationId,
    memoryVersionId: row.memoryVersionId,
    open: row.endedAt === null,
  };
}

export interface LedgerInsert {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly planId: string;
  readonly nodeId: string;
  readonly entitySchemaId: string | null;
  readonly entity: string;
  readonly externalRef: string;
  readonly adapterUsed: MaterializerKind;
  readonly payload: unknown;
  readonly provenance: readonly ProvenanceEntry[];
  readonly inverseOp: InverseOperation;
}

/**
 * Record one created record.
 *
 * Written after the record exists, never before. A ledger entry for a record that was not created
 * is worse than no entry at all: a revert would go looking for something that never existed and
 * report a failure the tester cannot act on.
 *
 * Idempotent on `(planId, nodeId)`, which the schema already makes unique. Approval is a human
 * action and a double-click is a real thing; the second insert returns the first row rather than
 * a constraint violation, and the record is created once because the *chain* runs once.
 */
export async function insertLedgerEntry(
  db: ScopedDatabase,
  entry: LedgerInsert,
): Promise<SeedLedgerEntry> {
  const row = await db
    .insertInto('seedLedger')
    .values({
      tenantId: entry.tenantId,
      sessionId: entry.sessionId,
      planId: entry.planId,
      nodeId: entry.nodeId,
      entitySchemaId: entry.entitySchemaId,
      entity: entry.entity,
      externalRef: entry.externalRef,
      adapterUsed: entry.adapterUsed,
      payload: JSON.stringify(entry.payload ?? {}),
      provenance: JSON.stringify(entry.provenance),
      inverseOp: JSON.stringify(entry.inverseOp),
    })
    .onConflict((conflict) =>
      conflict.columns(['planId', 'nodeId']).doUpdateSet((eb) => ({
        externalRef: eb.ref('excluded.externalRef'),
      })),
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  return toLedgerEntry(row);
}

/** One ledger entry by id, or null when this tenant has none. */
export async function findLedgerEntry(
  db: ScopedDatabase,
  id: string,
): Promise<SeedLedgerEntry | null> {
  const row = await db.selectFrom('seedLedger').selectAll().where('id', '=', id).executeTakeFirst();
  return row === undefined ? null : toLedgerEntry(row);
}

/**
 * Everything a session seeded and has not yet reverted, newest first.
 *
 * Newest first *is* reverse dependency order. A plan's `materializationOrder` creates a referenced
 * record before the record that references it, so undoing in reverse insertion order takes the
 * dependent row out before the row it points at — which is the only order a foreign key will
 * accept (docs/TEST-DATA-ENGINE.md § 5).
 */
export async function listOutstandingForSession(
  db: ScopedDatabase,
  sessionId: string,
): Promise<SeedLedgerEntry[]> {
  const rows = await db
    .selectFrom('seedLedger')
    .selectAll()
    .where('sessionId', '=', sessionId)
    .where('revertedAt', 'is', null)
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .execute();

  return rows.map(toLedgerEntry);
}

/**
 * Stamp an entry reverted.
 *
 * Conditional on it not already being reverted, so two concurrent reverts of the same session
 * cannot both claim to have removed the same record. The caller distinguishes "I reverted it"
 * from "somebody else already had" by whether a row came back.
 */
export async function markReverted(db: ScopedDatabase, id: string): Promise<boolean> {
  const row = await db
    .updateTable('seedLedger')
    .set({ revertedAt: new Date() })
    .where('id', '=', id)
    .where('revertedAt', 'is', null)
    .returning('id')
    .executeTakeFirst();

  return row !== undefined;
}

/**
 * Record a governed action.
 *
 * Every seed attempt lands here, including the ones policy refused — an audit trail that only
 * records what succeeded answers none of the questions an audit is for. The actor is free text
 * because it may be a service, and because the record has to survive the account being deleted
 * (ARCHITECTURE § 8).
 */
export async function recordAudit(
  db: ScopedDatabase,
  entry: {
    readonly tenantId: string;
    readonly actor: string;
    readonly action: string;
    readonly target: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await db
    .insertInto('auditLog')
    .values({
      tenantId: entry.tenantId,
      actor: entry.actor,
      action: entry.action,
      target: entry.target,
      metadata: JSON.stringify(entry.metadata),
    })
    .execute();
}

interface LedgerRow {
  readonly id: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly planId: string;
  readonly nodeId: string;
  readonly entitySchemaId: string | null;
  readonly entity: string;
  readonly externalRef: string;
  readonly adapterUsed: string;
  readonly payload: unknown;
  readonly provenance: unknown;
  readonly inverseOp: unknown;
  readonly createdAt: Date;
  readonly revertedAt: Date | null;
}

function toLedgerEntry(row: LedgerRow): SeedLedgerEntry {
  const parsed = SeedLedgerEntrySchema.safeParse({
    id: row.id,
    tenantId: row.tenantId,
    sessionId: row.sessionId,
    planId: row.planId,
    nodeId: row.nodeId,
    entitySchemaId: row.entitySchemaId,
    entity: row.entity,
    externalRef: row.externalRef,
    adapterUsed: row.adapterUsed,
    payload: row.payload,
    provenance: row.provenance,
    inverseOp: row.inverseOp,
    createdAt: row.createdAt.toISOString(),
    revertedAt: row.revertedAt?.toISOString() ?? null,
  });

  if (!parsed.success) {
    throw new GatewayError('internal', 'a stored ledger entry does not match the contract', {
      ledgerEntryId: row.id,
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  }

  return parsed.data;
}
