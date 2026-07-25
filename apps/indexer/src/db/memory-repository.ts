import { sql } from 'kysely';
import type { ElementFingerprint, MemoryVersionStatus, NavPrecondition } from 'protocol';

import type { ScopedDatabase } from './pool.js';

/**
 * Everything the indexer writes, in one place.
 *
 * No method writes a `where tenant_id = …`: row-level security applies it, and a filter
 * duplicated in application code is one that can drift from the policy. The `tenantId` columns
 * *are* set explicitly on insert, because the schema requires them and because the composite
 * foreign keys then prove each row agrees with its owner's tenant.
 *
 * ## Idempotence, and why it is not optional
 *
 * A crashed job resumes (docs/BUILD-PLAN.md Phase 5: "restarts from the last completed route,
 * not from scratch"), so every write here can legitimately run twice for the same route. Each
 * one is an upsert on the natural key the schema already enforces — `(memory_version_id,
 * state_fingerprint)` for a screen, `(screen_id, element_key)` for an element — so a resumed
 * crawl converges on the same memory a clean one would produce, rather than failing on a
 * conflict or writing a duplicate.
 */

export interface ApplicationRecord {
  readonly id: string;
  readonly baseUrl: string;
  readonly env: string;
}

/** The application under test, as registered. Null when it does not exist in this tenant. */
export async function findApplication(
  db: ScopedDatabase,
  applicationId: string,
): Promise<ApplicationRecord | null> {
  const row = await db
    .selectFrom('applications')
    .select(['id', 'baseUrl', 'env'])
    .where('id', '=', applicationId)
    .executeTakeFirst();

  return row ?? null;
}

export interface MemoryVersionRecord {
  readonly id: string;
  readonly version: number;
  /** True when this version already existed in `building` state and is being continued. */
  readonly resumed: boolean;
}

/**
 * Open the memory version this job will fill in, or adopt the one it left behind.
 *
 * A `building` version for the application means a previous attempt at this crawl died partway.
 * Adopting it — rather than opening a second one — is what makes resumption cheap: the screens
 * already written are already there, and the upserts below simply skip them.
 *
 * A new version takes `max(version) + 1`. The unique index on `(application_id, version)` means
 * two workers racing to open one cannot both win; the loser's insert fails and its job is retried
 * against the version the winner opened.
 */
export async function openMemoryVersion(
  db: ScopedDatabase,
  tenantId: string,
  applicationId: string,
): Promise<MemoryVersionRecord> {
  const existing = await db
    .selectFrom('memoryVersions')
    .select(['id', 'version'])
    .where('applicationId', '=', applicationId)
    .where('status', '=', 'building')
    .orderBy('version', 'desc')
    .executeTakeFirst();

  if (existing !== undefined) {
    return { id: existing.id, version: existing.version, resumed: true };
  }

  const highest = await db
    .selectFrom('memoryVersions')
    .select(({ fn }) => fn.max<number | null>('version').as('version'))
    .where('applicationId', '=', applicationId)
    .executeTakeFirst();

  const version = (highest?.version ?? 0) + 1;

  const inserted = await db
    .insertInto('memoryVersions')
    .values({
      tenantId,
      applicationId,
      version,
      status: 'building' satisfies MemoryVersionStatus,
      // Null: a version has no approver until a human approves it, and an index job is not one.
      approvedBy: null,
      failureReason: null,
    })
    .returning(['id', 'version'])
    .executeTakeFirstOrThrow();

  return { id: inserted.id, version: inserted.version, resumed: false };
}

export interface ScreenInput {
  readonly tenantId: string;
  readonly memoryVersionId: string;
  readonly routePattern: string;
  readonly stateFingerprint: string;
  readonly label: string;
  readonly structuralHash: string;
}

/** Insert or refresh one screen, returning its id. Keyed on `(memoryVersionId, stateFingerprint)`. */
export async function upsertScreen(db: ScopedDatabase, screen: ScreenInput): Promise<string> {
  const row = await db
    .insertInto('screens')
    .values({
      tenantId: screen.tenantId,
      memoryVersionId: screen.memoryVersionId,
      routePattern: screen.routePattern,
      stateFingerprint: screen.stateFingerprint,
      label: screen.label,
      structuralHash: screen.structuralHash,
    })
    .onConflict((conflict) =>
      conflict.columns(['memoryVersionId', 'stateFingerprint']).doUpdateSet({
        label: screen.label,
        structuralHash: screen.structuralHash,
        routePattern: screen.routePattern,
        indexedAt: sql`now()`,
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();

  return row.id;
}

export interface ElementInput {
  readonly tenantId: string;
  readonly screenId: string;
  readonly elementKey: string;
  readonly fingerprint: ElementFingerprint;
  readonly confidence: number;
  readonly stability: number;
}

/**
 * Write one screen's elements, returning their ids by element key.
 *
 * Batched into a single statement: a screen routinely carries a few hundred controls, and a
 * round trip each would dominate the per-route budget that ARCHITECTURE § 5's throughput figure
 * is measured against.
 */
export async function upsertElements(
  db: ScopedDatabase,
  elements: readonly ElementInput[],
): Promise<Map<string, string>> {
  if (elements.length === 0) return new Map();

  const rows = await db
    .insertInto('elements')
    .values(
      elements.map((element) => ({
        tenantId: element.tenantId,
        screenId: element.screenId,
        elementKey: element.elementKey,
        role: element.fingerprint.role,
        accessibleNameHash: element.fingerprint.accessibleNameHash,
        fingerprint: JSON.stringify(element.fingerprint),
        confidence: element.confidence,
        stability: element.stability,
      })),
    )
    .onConflict((conflict) =>
      conflict.columns(['screenId', 'elementKey']).doUpdateSet((eb) => ({
        role: eb.ref('excluded.role'),
        accessibleNameHash: eb.ref('excluded.accessibleNameHash'),
        fingerprint: eb.ref('excluded.fingerprint'),
        confidence: eb.ref('excluded.confidence'),
        stability: eb.ref('excluded.stability'),
      })),
    )
    .returning(['id', 'elementKey'])
    .execute();

  return new Map(rows.map((row) => [row.elementKey, row.id]));
}

export interface NavEdgeInput {
  readonly tenantId: string;
  readonly memoryVersionId: string;
  readonly fromScreenId: string;
  readonly toScreenId: string;
  readonly triggerElementId: string;
  readonly preconditions: readonly NavPrecondition[];
  readonly confidence: number;
}

/** Record one observed transition. Repeated observations of the same edge collapse into one row. */
export async function upsertNavEdge(db: ScopedDatabase, edge: NavEdgeInput): Promise<void> {
  await db
    .insertInto('navEdges')
    .values({
      tenantId: edge.tenantId,
      memoryVersionId: edge.memoryVersionId,
      fromScreen: edge.fromScreenId,
      toScreen: edge.toScreenId,
      triggerElement: edge.triggerElementId,
      preconditions: JSON.stringify(edge.preconditions),
      confidence: edge.confidence,
    })
    .onConflict((conflict) =>
      conflict
        .columns(['memoryVersionId', 'fromScreen', 'toScreen', 'triggerElement'])
        .doUpdateSet({ confidence: edge.confidence }),
    )
    .execute();
}

export interface IndexedScreenRecord {
  readonly id: string;
  readonly routePattern: string;
  readonly stateFingerprint: string;
}

/**
 * Screens already written under a version — the resume manifest.
 *
 * Read from Postgres rather than from the Redis checkpoint because the database is what
 * actually holds the work. A checkpoint can be lost, expired or written a moment before the
 * process died; the screens are either committed or they are not.
 */
export async function listIndexedScreens(
  db: ScopedDatabase,
  memoryVersionId: string,
): Promise<IndexedScreenRecord[]> {
  return db
    .selectFrom('screens')
    .select(['id', 'routePattern', 'stateFingerprint'])
    .where('memoryVersionId', '=', memoryVersionId)
    .execute();
}

/**
 * The version this one supersedes, if there is one.
 *
 * Used to derive element stability: an element that was present in the previous version and is
 * present again has re-resolved once. On the very first index there is no predecessor, and the
 * honest value for "how often has this re-resolved" is zero — meaning *no evidence yet*, not
 * *known unstable*. Later versions raise it.
 */
export async function findPreviousMemoryVersion(
  db: ScopedDatabase,
  applicationId: string,
  currentVersionId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('memoryVersions')
    .select('id')
    .where('applicationId', '=', applicationId)
    .where('id', '!=', currentVersionId)
    .where('status', 'in', ['active', 'superseded'])
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirst();

  return row?.id ?? null;
}

/** Element keys recorded for one state fingerprint in a given version. */
export async function listElementKeysForState(
  db: ScopedDatabase,
  memoryVersionId: string,
  stateFingerprint: string,
): Promise<Set<string>> {
  const rows = await db
    .selectFrom('elements')
    .innerJoin('screens', 'screens.id', 'elements.screenId')
    .select('elements.elementKey')
    .where('screens.memoryVersionId', '=', memoryVersionId)
    .where('screens.stateFingerprint', '=', stateFingerprint)
    .execute();

  return new Set(rows.map((row) => row.elementKey));
}

/** How many elements and edges a version holds. Reported in the completion event. */
export async function countMemoryVersionContents(
  db: ScopedDatabase,
  memoryVersionId: string,
): Promise<{ screens: number; elements: number; edges: number }> {
  const screens = await db
    .selectFrom('screens')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('memoryVersionId', '=', memoryVersionId)
    .executeTakeFirstOrThrow();

  const elements = await db
    .selectFrom('elements')
    .innerJoin('screens', 'screens.id', 'elements.screenId')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('screens.memoryVersionId', '=', memoryVersionId)
    .executeTakeFirstOrThrow();

  const edges = await db
    .selectFrom('navEdges')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('memoryVersionId', '=', memoryVersionId)
    .executeTakeFirstOrThrow();

  return {
    screens: Number(screens.count),
    elements: Number(elements.count),
    edges: Number(edges.count),
  };
}

/**
 * Flip a completed version to `active`, superseding whichever version was active before.
 *
 * Both statements run inside the caller's transaction, because
 * `memory_versions_one_active_per_application` is a unique index: activating the new version
 * before superseding the old one would violate it, and doing it in two transactions would leave
 * a window with no active version at all — during which every extension attaching to this
 * application would find no memory to load.
 */
export async function activateMemoryVersion(
  db: ScopedDatabase,
  applicationId: string,
  memoryVersionId: string,
): Promise<void> {
  await db
    .updateTable('memoryVersions')
    .set({ status: 'superseded' satisfies MemoryVersionStatus })
    .where('applicationId', '=', applicationId)
    .where('status', '=', 'active')
    .where('id', '!=', memoryVersionId)
    .execute();

  await db
    .updateTable('memoryVersions')
    .set({ status: 'active' satisfies MemoryVersionStatus, failureReason: null })
    .where('id', '=', memoryVersionId)
    .execute();
}

/**
 * Mark a version failed, with the reason an operator will read.
 *
 * The version is left in place rather than deleted: a failed crawl's partial screens are
 * evidence about where it failed, and the schema's `failed`/`failure_reason` CHECK keeps the two
 * columns honest about each other.
 */
export async function failMemoryVersion(
  db: ScopedDatabase,
  memoryVersionId: string,
  reason: string,
): Promise<void> {
  await db
    .updateTable('memoryVersions')
    .set({ status: 'failed' satisfies MemoryVersionStatus, failureReason: reason })
    .where('id', '=', memoryVersionId)
    .execute();
}
