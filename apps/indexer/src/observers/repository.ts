import type { ScopedDatabase } from '../db/pool.js';
import type { EntitySchemaDraft, FieldSpecDraft, MaterializerDraft } from './consolidate.js';

/**
 * Writing learned schemas to `entity_schemas` / `field_specs` / `materializers`.
 *
 * Everything is keyed on the memory version, per docs/ARCHITECTURE.md § 4 — the same versioning
 * that screens, elements and edges use, and for the same reason: when an application changes,
 * the schemas learned from the old one must not silently describe the new one. A crawl opens a
 * version, fills it, and flips it to `active`; the extension and the composer read one version
 * and see a consistent picture of the application at one moment.
 *
 * ## Idempotence
 *
 * A crashed job resumes into the version it left behind, so every write here can legitimately
 * run twice. Each is an upsert on the natural key the schema already enforces —
 * `(memory_version_id, entity_name)`, `(entity_schema_id, name)`, `(entity_schema_id, kind)` —
 * exactly like the memory repository, so a resumed crawl converges on the schemas a clean one
 * would have produced.
 *
 * ## Nothing is deleted
 *
 * A second pass that observed fewer fields does not remove the ones it missed. A route that
 * failed to load, a form behind a permission the crawl's account lacks, an API call that timed
 * out — all of them look identical to "the field is gone", and forgetting a real field breaks
 * composition where keeping a stale one merely leaves it unreferenced. Retiring genuinely
 * removed fields is drift reconciliation's job, and it goes through human approval.
 *
 * ## PII
 *
 * Everything reaching these tables has already been through `observers/pii.ts`. This module adds
 * no values of its own, and it deliberately does not log the rows it writes — a debug line
 * carrying a field spec would carry the enum vocabulary with it.
 */

export interface PersistOptions {
  readonly tenantId: string;
  readonly memoryVersionId: string;
}

export interface PersistedSchemaCounts {
  readonly entities: number;
  readonly fields: number;
  readonly materializers: number;
}

/** Insert or refresh one entity schema, returning its id. */
async function upsertEntitySchema(
  db: ScopedDatabase,
  options: PersistOptions,
  draft: EntitySchemaDraft,
): Promise<string> {
  const row = await db
    .insertInto('entitySchemas')
    .values({
      tenantId: options.tenantId,
      memoryVersionId: options.memoryVersionId,
      entityName: draft.entityName,
      observedCount: draft.observedCount,
      confidence: draft.confidence,
    })
    .onConflict((conflict) =>
      conflict.columns(['memoryVersionId', 'entityName']).doUpdateSet({
        observedCount: draft.observedCount,
        confidence: draft.confidence,
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();

  return row.id;
}

/**
 * Write one entity's fields.
 *
 * Batched into a single statement: an entity of thirty fields observed across five routes would
 * otherwise cost thirty round trips per route, on the wrong side of the throughput budget in
 * CLAUDE.md § "Performance budgets".
 */
async function upsertFieldSpecs(
  db: ScopedDatabase,
  options: PersistOptions,
  entitySchemaId: string,
  fields: readonly FieldSpecDraft[],
): Promise<number> {
  if (fields.length === 0) return 0;

  const rows = await db
    .insertInto('fieldSpecs')
    .values(
      fields.map((field) => ({
        tenantId: options.tenantId,
        entitySchemaId,
        name: field.name,
        type: field.type,
        required: field.required,
        derivedRule: field.derivedRule === null ? null : JSON.stringify(field.derivedRule),
        enumValues: field.enumValues === null ? null : JSON.stringify(field.enumValues),
        distribution: field.distribution === null ? null : JSON.stringify(field.distribution),
        referencesEntity: field.referencesEntity,
        valueConstraints: JSON.stringify(field.valueConstraints),
        controlElementKey: field.controlElementKey,
        isUnique: field.unique,
      })),
    )
    .onConflict((conflict) =>
      conflict.columns(['entitySchemaId', 'name']).doUpdateSet((eb) => ({
        type: eb.ref('excluded.type'),
        required: eb.ref('excluded.required'),
        derivedRule: eb.ref('excluded.derivedRule'),
        enumValues: eb.ref('excluded.enumValues'),
        distribution: eb.ref('excluded.distribution'),
        referencesEntity: eb.ref('excluded.referencesEntity'),
        valueConstraints: eb.ref('excluded.valueConstraints'),
        controlElementKey: eb.ref('excluded.controlElementKey'),
        isUnique: eb.ref('excluded.isUnique'),
      })),
    )
    .returning('id')
    .execute();

  return rows.length;
}

/** Write one entity's materializers. At most one per kind, which the schema enforces. */
async function upsertMaterializers(
  db: ScopedDatabase,
  options: PersistOptions,
  entitySchemaId: string,
  materializers: readonly MaterializerDraft[],
): Promise<number> {
  if (materializers.length === 0) return 0;

  const rows = await db
    .insertInto('materializers')
    .values(
      materializers.map((materializer) => ({
        tenantId: options.tenantId,
        entitySchemaId,
        kind: materializer.spec.kind,
        spec: JSON.stringify(materializer.spec),
        priority: materializer.priority,
        verifiedAt: materializer.verifiedAt,
        verificationTtlHours: materializer.verificationTtlHours,
      })),
    )
    .onConflict((conflict) =>
      conflict.columns(['entitySchemaId', 'kind']).doUpdateSet((eb) => ({
        spec: eb.ref('excluded.spec'),
        priority: eb.ref('excluded.priority'),
        verificationTtlHours: eb.ref('excluded.verificationTtlHours'),
      })),
    )
    .returning('id')
    .execute();

  return rows.length;
}

/**
 * Persist every learned schema against one memory version.
 *
 * One transaction per entity rather than one for the whole set: a crawl of a large application
 * can learn dozens, and holding a single transaction across all of them would keep locks on
 * three tables for the duration of the consolidation.
 */
export async function persistSchemas(
  withTenant: <T>(work: (db: ScopedDatabase) => Promise<T>) => Promise<T>,
  options: PersistOptions,
  schemas: readonly EntitySchemaDraft[],
): Promise<PersistedSchemaCounts> {
  let entities = 0;
  let fields = 0;
  let materializers = 0;

  for (const schema of schemas) {
    const counts = await withTenant(async (db) => {
      const entitySchemaId = await upsertEntitySchema(db, options, schema);
      return {
        fields: await upsertFieldSpecs(db, options, entitySchemaId, schema.fields),
        materializers: await upsertMaterializers(db, options, entitySchemaId, schema.materializers),
      };
    });

    entities += 1;
    fields += counts.fields;
    materializers += counts.materializers;
  }

  return { entities, fields, materializers };
}
