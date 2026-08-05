import { sql } from 'kysely';

import type { ScopedDatabase } from '../db/pool.js';

/**
 * Cloning a memory version, so a reconcile has something to change.
 *
 * A drift reconcile proposes a *new* version rather than editing the live one. That is what makes
 * approval reversible: the version a tester is resolving against keeps working while the proposal
 * waits, and a bad approval is a rollback rather than a reconstruction (ADR 0007, and
 * db/migrations/20260805120000_drift_candidate_and_route.sql).
 *
 * ## The clone needs no id bookkeeping, because the schema already has the keys
 *
 * Every table here is reachable from the version by a natural key the database already enforces
 * as unique:
 *
 * | Table            | Key that survives a clone                     |
 * |------------------|-----------------------------------------------|
 * | `screens`        | `(memory_version_id, state_fingerprint)`      |
 * | `elements`       | `(screen_id, element_key)`                    |
 * | `entity_schemas` | `(memory_version_id, entity_name)`            |
 * | `field_specs`    | `(entity_schema_id, name)`                    |
 * | `materializers`  | `(entity_schema_id, kind)`                    |
 *
 * So each insert joins the new rows back to the old ones on that key rather than carrying a map of
 * old id → new id through the process. The join *is* the identity, and it is the same identity the
 * gateway uses to migrate aliases at approval time — which is why the two cannot disagree about
 * which element in the candidate corresponds to which in the original.
 *
 * ## Aliases are deliberately not cloned
 *
 * They are migrated by the gateway when a human approves, and counted while it happens, because
 * "seven of your forty phrases no longer resolve" is a thing a lead decides about rather than
 * discovers. Copying them here would double every one of them and make that count meaningless.
 *
 * ## Nav edges whose element did not survive are dropped, not repaired
 *
 * The insert joins through the element map, so an edge triggered by an element the reconcile
 * removed simply finds no row and is not written. That is correct: an edge is a claim that
 * clicking a specific control goes somewhere, and a control that no longer exists cannot.
 */

export interface CloneResult {
  readonly memoryVersionId: string;
  readonly version: number;
  readonly screens: number;
  readonly elements: number;
}

/**
 * Copy a version's structure and learned data into a fresh `building` version.
 *
 * The new version is `origin = 'reconcile'`, which is what keeps a crawl from resuming it —
 * see db/migrations/20260805130000_memory_version_origin.sql.
 */
export async function cloneMemoryVersion(
  db: ScopedDatabase,
  tenantId: string,
  applicationId: string,
  sourceVersionId: string,
): Promise<CloneResult> {
  const highest = await db
    .selectFrom('memoryVersions')
    .select(({ fn }) => fn.max<number | null>('version').as('version'))
    .where('applicationId', '=', applicationId)
    .executeTakeFirst();

  const version = (highest?.version ?? 0) + 1;

  const created = await db
    .insertInto('memoryVersions')
    .values({
      tenantId,
      applicationId,
      version,
      status: 'building',
      origin: 'reconcile',
      // A candidate has no approver. Populating it here is the auto-approve path ADR 0007
      // forbids, and it would be invisible — the row would simply look already-reviewed.
      approvedBy: null,
      failureReason: null,
    })
    .returning(['id', 'version'])
    .executeTakeFirstOrThrow();

  const target = created.id;

  const screens = await sql<{ count: string }>`
    WITH copied AS (
      INSERT INTO screens (tenant_id, memory_version_id, route_pattern, state_fingerprint, label, structural_hash)
      SELECT tenant_id, ${target}::uuid, route_pattern, state_fingerprint, label, structural_hash
        FROM screens WHERE memory_version_id = ${sourceVersionId}::uuid
      RETURNING id
    )
    SELECT count(*)::text AS count FROM copied
  `.execute(db);

  const elements = await sql<{ count: string }>`
    WITH copied AS (
      INSERT INTO elements (tenant_id, screen_id, element_key, role, accessible_name_hash, fingerprint, confidence, stability)
      SELECT source.tenant_id, target_screen.id, source.element_key, source.role,
             source.accessible_name_hash, source.fingerprint, source.confidence, source.stability
        FROM elements source
        JOIN screens source_screen ON source_screen.id = source.screen_id
        JOIN screens target_screen
          ON target_screen.memory_version_id = ${target}::uuid
         AND target_screen.state_fingerprint = source_screen.state_fingerprint
       WHERE source_screen.memory_version_id = ${sourceVersionId}::uuid
      RETURNING id
    )
    SELECT count(*)::text AS count FROM copied
  `.execute(db);

  await sql`
    INSERT INTO nav_edges (tenant_id, memory_version_id, from_screen, to_screen, trigger_element, preconditions, confidence)
    SELECT source.tenant_id, ${target}::uuid, target_from.id, target_to.id, target_element.id,
           source.preconditions, source.confidence
      FROM nav_edges source
      JOIN screens source_from ON source_from.id = source.from_screen
      JOIN screens source_to ON source_to.id = source.to_screen
      JOIN elements source_element ON source_element.id = source.trigger_element
      JOIN screens source_element_screen ON source_element_screen.id = source_element.screen_id
      JOIN screens target_from
        ON target_from.memory_version_id = ${target}::uuid
       AND target_from.state_fingerprint = source_from.state_fingerprint
      JOIN screens target_to
        ON target_to.memory_version_id = ${target}::uuid
       AND target_to.state_fingerprint = source_to.state_fingerprint
      JOIN screens target_element_screen
        ON target_element_screen.memory_version_id = ${target}::uuid
       AND target_element_screen.state_fingerprint = source_element_screen.state_fingerprint
      JOIN elements target_element
        ON target_element.screen_id = target_element_screen.id
       AND target_element.element_key = source_element.element_key
     WHERE source.memory_version_id = ${sourceVersionId}::uuid
  `.execute(db);

  await sql`
    INSERT INTO entity_schemas (tenant_id, memory_version_id, entity_name, observed_count, confidence, delete_flow_element_key)
    SELECT tenant_id, ${target}::uuid, entity_name, observed_count, confidence, delete_flow_element_key
      FROM entity_schemas WHERE memory_version_id = ${sourceVersionId}::uuid
  `.execute(db);

  await sql`
    INSERT INTO field_specs (tenant_id, entity_schema_id, name, type, required, value_constraints,
                             enum_values, distribution, derived_rule, references_entity,
                             control_element_key, is_unique)
    SELECT source.tenant_id, target_schema.id, source.name, source.type, source.required,
           source.value_constraints, source.enum_values, source.distribution, source.derived_rule,
           source.references_entity, source.control_element_key, source.is_unique
      FROM field_specs source
      JOIN entity_schemas source_schema ON source_schema.id = source.entity_schema_id
      JOIN entity_schemas target_schema
        ON target_schema.memory_version_id = ${target}::uuid
       AND target_schema.entity_name = source_schema.entity_name
     WHERE source_schema.memory_version_id = ${sourceVersionId}::uuid
  `.execute(db);

  await sql`
    INSERT INTO materializers (tenant_id, entity_schema_id, kind, spec, priority, verified_at, verification_ttl_hours)
    SELECT source.tenant_id, target_schema.id, source.kind, source.spec, source.priority,
           source.verified_at, source.verification_ttl_hours
      FROM materializers source
      JOIN entity_schemas source_schema ON source_schema.id = source.entity_schema_id
      JOIN entity_schemas target_schema
        ON target_schema.memory_version_id = ${target}::uuid
       AND target_schema.entity_name = source_schema.entity_name
     WHERE source_schema.memory_version_id = ${sourceVersionId}::uuid
  `.execute(db);

  return {
    memoryVersionId: target,
    version: created.version,
    screens: Number(screens.rows[0]?.count ?? 0),
    elements: Number(elements.rows[0]?.count ?? 0),
  };
}
