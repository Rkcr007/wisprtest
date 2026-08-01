import { sql } from 'kysely';
import { DerivedRule, FieldDistribution, FieldType, FieldValueConstraints } from 'protocol';
import { z } from 'zod';

import type { ScopedDatabase } from '../db/pool.js';
import {
  mergeFieldSpecs,
  type EntitySchemaDraft,
  type FieldSpecDraft,
  type MaterializerDraft,
} from './consolidate.js';

/** The "no limits observed" value, used when a stored `value_constraints` will not parse. */
const EMPTY_CONSTRAINTS: FieldValueConstraints = {
  min: null,
  max: null,
  minLength: null,
  maxLength: null,
  pattern: null,
};

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

/**
 * Insert or refresh one entity schema, returning its id.
 *
 * `observed_count` and `confidence` only ever climb. A resumed crawl inherits its predecessor's
 * screens and therefore re-walks fewer routes, so it genuinely observes less — and the version's
 * knowledge is the union of both attempts, not whatever the last one happened to see.
 */
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
      conflict.columns(['memoryVersionId', 'entityName']).doUpdateSet((eb) => ({
        observedCount: sql<number>`greatest(${eb.ref('excluded.observedCount')}, ${eb.ref('entitySchemas.observedCount')})`,
        confidence: sql<number>`greatest(${eb.ref('excluded.confidence')}, ${eb.ref('entitySchemas.confidence')})`,
      })),
    )
    .returning('id')
    .executeTakeFirstOrThrow();

  return row.id;
}

/**
 * The field specs already written for an entity, keyed by name.
 *
 * Parsed through the contract rather than cast: a row that does not validate is treated as
 * absent, so a schema written by an older build can never crash a crawl — it is simply
 * re-learned. Returning `null` for an unparseable column loses nothing that the observation
 * about to be merged in does not supply.
 */
async function loadFieldSpecs(
  db: ScopedDatabase,
  entitySchemaId: string,
): Promise<Map<string, FieldSpecDraft>> {
  const rows = await db
    .selectFrom('fieldSpecs')
    .select([
      'name',
      'type',
      'required',
      'derivedRule',
      'enumValues',
      'distribution',
      'referencesEntity',
      'valueConstraints',
      'controlElementKey',
      'isUnique',
    ])
    .where('entitySchemaId', '=', entitySchemaId)
    .execute();

  const existing = new Map<string, FieldSpecDraft>();

  for (const row of rows) {
    const type = FieldType.safeParse(row.type);
    if (!type.success) continue;

    const derivedRule = DerivedRule.safeParse(row.derivedRule);
    const distribution = FieldDistribution.safeParse(row.distribution);
    const enumValues = z.array(z.string()).safeParse(row.enumValues);
    const valueConstraints = FieldValueConstraints.safeParse(row.valueConstraints);

    existing.set(row.name, {
      name: row.name,
      type: type.data,
      required: row.required,
      derivedRule: derivedRule.success ? derivedRule.data : null,
      enumValues: enumValues.success ? enumValues.data : null,
      distribution: distribution.success ? distribution.data : null,
      referencesEntity: row.referencesEntity,
      valueConstraints: valueConstraints.success ? valueConstraints.data : EMPTY_CONSTRAINTS,
      controlElementKey: row.controlElementKey,
      unique: row.isUnique,
    });
  }

  return existing;
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
  observed: readonly FieldSpecDraft[],
): Promise<number> {
  if (observed.length === 0) return 0;

  // Read before write. The alternative — letting the insert's `excluded` row win column by
  // column — means the *last* crawl to touch a field decides what is known about it, and a
  // resumed crawl re-walks fewer routes than the attempt it is continuing. It would overwrite a
  // learned distribution with null, and a required field with an optional one, purely because it
  // never loaded the page that said otherwise.
  const existing = await loadFieldSpecs(db, entitySchemaId);
  const fields = observed.map((field) => {
    const previous = existing.get(field.name);
    return previous === undefined ? field : mergeFieldSpecs(previous, field);
  });

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
