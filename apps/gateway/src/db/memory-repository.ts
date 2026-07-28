import { sql } from 'kysely';
import {
  type AliasWriteback,
  type AliasWritebackResult,
  type MemorySnapshot,
  MemorySnapshot as MemorySnapshotSchema,
} from 'protocol';

import type { ScopedDatabase } from './pool.js';

/**
 * The reads and the one write behind the memory endpoints.
 *
 * No method writes a `where tenant_id = …`: row-level security applies it, and a duplicated
 * filter is one that can drift from the policy. The alias upsert *does* set `tenant_id`
 * explicitly on insert, because the schema requires it and the composite foreign keys then prove
 * each row agrees with its owner's tenant — an alias write-back naming an element in another
 * tenant fails the `aliases_element_fkey` rather than leaking.
 *
 * ## Why the snapshot is validated here
 *
 * `loadSnapshot` runs the assembled payload through `MemorySnapshot.parse` before returning it.
 * The snapshot is cached and then held by the extension for a whole session, so a shape the
 * contract would reject is a shape that would fail in a tester's tab minutes later, far from the
 * query that produced it. Validating once, at assembly, turns that into a 5xx at fetch time with
 * a trace id — and it is paid once per version, not once per request, because the result is
 * cached.
 */

interface ActiveVersionRow {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly version: number;
  readonly status: string;
  readonly createdAt: Date;
  readonly approvedBy: string | null;
  readonly failureReason: string | null;
}

/**
 * Assemble the compressed-cache payload for an application's active memory version.
 *
 * Returns null when the application has no active version — a normal answer for an app that is
 * still indexing or whose first crawl failed, which the route turns into a
 * `memory_snapshot_unavailable`, not an internal error.
 */
export async function loadSnapshot(
  db: ScopedDatabase,
  applicationId: string,
): Promise<MemorySnapshot | null> {
  const version = await db
    .selectFrom('memoryVersions')
    .select([
      'id',
      'tenantId',
      'applicationId',
      'version',
      'status',
      'createdAt',
      'approvedBy',
      'failureReason',
    ])
    .where('applicationId', '=', applicationId)
    .where('status', '=', 'active')
    .executeTakeFirst();

  if (version === undefined) return null;
  const active = version as ActiveVersionRow;

  const [screens, elements, navEdges, aliases] = await Promise.all([
    db
      .selectFrom('screens')
      .select([
        'id',
        'memoryVersionId',
        'routePattern',
        'stateFingerprint',
        'label',
        'structuralHash',
        'indexedAt',
      ])
      .where('memoryVersionId', '=', active.id)
      .orderBy('routePattern')
      .execute(),
    db
      .selectFrom('elements')
      .innerJoin('screens', 'screens.id', 'elements.screenId')
      .select([
        'elements.id as id',
        'elements.screenId as screenId',
        'elements.elementKey as elementKey',
        'elements.fingerprint as fingerprint',
        'elements.confidence as confidence',
        'elements.stability as stability',
      ])
      .where('screens.memoryVersionId', '=', active.id)
      .orderBy('elements.elementKey')
      .execute(),
    db
      .selectFrom('navEdges')
      .select([
        'id',
        'memoryVersionId',
        'fromScreen',
        'toScreen',
        'triggerElement',
        'preconditions',
        'confidence',
      ])
      .where('memoryVersionId', '=', active.id)
      .execute(),
    db
      .selectFrom('aliases')
      .select([
        'id',
        'tenantId',
        'memoryVersionId',
        'phrase',
        'elementId',
        'stateFingerprint',
        'source',
        'hits',
        'createdAt',
      ])
      .where('memoryVersionId', '=', active.id)
      .execute(),
  ]);

  const snapshot: MemorySnapshot = {
    tenantId: active.tenantId,
    applicationId: active.applicationId,
    memoryVersion: {
      id: active.id,
      tenantId: active.tenantId,
      applicationId: active.applicationId,
      version: active.version,
      status: active.status as MemorySnapshot['memoryVersion']['status'],
      createdAt: active.createdAt.toISOString(),
      approvedBy: active.approvedBy,
      failureReason: active.failureReason,
    },
    screens: screens.map((row) => ({
      id: row.id,
      memoryVersionId: row.memoryVersionId,
      routePattern: row.routePattern,
      stateFingerprint: row.stateFingerprint,
      label: row.label,
      structuralHash: row.structuralHash,
      indexedAt: row.indexedAt.toISOString(),
    })),
    elements: elements.map((row) => ({
      id: row.id,
      screenId: row.screenId,
      elementKey: row.elementKey,
      // Stored as jsonb; validated against `ElementFingerprint` by the `MemorySnapshot.parse`
      // below rather than trusted blindly.
      fingerprint: row.fingerprint as MemorySnapshot['elements'][number]['fingerprint'],
      confidence: Number(row.confidence),
      stability: Number(row.stability),
    })),
    navEdges: navEdges.map((row) => ({
      id: row.id,
      memoryVersionId: row.memoryVersionId,
      fromScreenId: row.fromScreen,
      toScreenId: row.toScreen,
      triggerElementId: row.triggerElement,
      preconditions: row.preconditions as MemorySnapshot['navEdges'][number]['preconditions'],
      confidence: Number(row.confidence),
    })),
    aliases: aliases.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      memoryVersionId: row.memoryVersionId,
      phrase: row.phrase,
      elementId: row.elementId,
      stateFingerprint: row.stateFingerprint,
      source: row.source as MemorySnapshot['aliases'][number]['source'],
      hits: row.hits,
      createdAt: row.createdAt.toISOString(),
    })),
    generatedAt: new Date().toISOString(),
  };

  return MemorySnapshotSchema.parse(snapshot);
}

/**
 * Persist a batch of alias write-backs, deduplicating on `(memory_version_id, phrase)`.
 *
 * One statement, not a loop: the extension flushes a queue, and a round trip per item would make
 * a batch of fifty cost fifty. The `ON CONFLICT` increments `hits` and re-points the mapping —
 * a tester correcting a phrase to a different element should update the element it resolves to,
 * not leave the old one and bury the correction under a bumped counter.
 *
 * `(xmax = 0)` in the `RETURNING` clause is Postgres' own way of telling an insert from an
 * update inside `INSERT … ON CONFLICT`: `xmax` is zero on a freshly inserted row and non-zero on
 * one that was updated. That is what lets the result split `inserted` from `updated`, which is
 * the difference between "learned something new" and "saw a known phrase again" — the two halves
 * of the compounding-loop metric.
 */
export async function upsertAliases(
  db: ScopedDatabase,
  tenantId: string,
  memoryVersionId: string,
  items: readonly AliasWriteback[],
): Promise<AliasWritebackResult> {
  const rows = await db
    .insertInto('aliases')
    .values(
      items.map((item) => ({
        tenantId,
        memoryVersionId,
        phrase: item.phrase,
        elementId: item.elementId,
        stateFingerprint: item.stateFingerprint,
        source: item.source,
        hits: 1,
      })),
    )
    .onConflict((conflict) =>
      conflict.columns(['tenantId', 'memoryVersionId', 'phrase']).doUpdateSet((eb) => ({
        elementId: eb.ref('excluded.elementId'),
        stateFingerprint: eb.ref('excluded.stateFingerprint'),
        source: eb.ref('excluded.source'),
        hits: sql<number>`aliases.hits + 1`,
        updatedAt: sql`now()`,
      })),
    )
    .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
    .execute();

  const inserted = rows.filter((row) => row.inserted).length;
  return { accepted: rows.length, inserted, updated: rows.length - inserted };
}
