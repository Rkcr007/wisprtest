import {
  ElementFingerprint,
  type DriftStatus,
  type ElementFingerprint as ElementFingerprintValue,
  type StructuralDiff,
} from 'protocol';

import { confidenceOf, type ScreenPopulation } from '../crawl/confidence.js';
import { ElementKeyMinter } from '../crawl/element-key.js';
import { upsertElements, type ElementInput } from '../db/memory-repository.js';
import type { ScopedDatabase } from '../db/pool.js';
import { PersistenceError } from '../errors.js';
import type { StoredElement } from './diff.js';

/**
 * The reads and writes a reconcile performs around the browser work.
 *
 * The same discipline as `seed/repository.ts`: a `DriftReconcileJob` carries ids, and everything
 * the worker needs is loaded here under row-level security. A job that carried fingerprints would
 * be a second copy of memory sitting in a Redis stream, free to disagree with the first.
 */

/** The report being reconciled, as the worker needs it. */
export interface ReconcileTarget {
  readonly id: string;
  readonly memoryVersionId: string;
  readonly screenId: string;
  readonly routePattern: string;
  readonly observedRoute: string;
  readonly status: DriftStatus;
  /** Present on the report and on the screen; the clone is joined back on it. */
  readonly stateFingerprint: string;
}

export async function findDriftReport(
  db: ScopedDatabase,
  driftReportId: string,
): Promise<ReconcileTarget | null> {
  const row = await db
    .selectFrom('driftReports')
    .select([
      'id',
      'memoryVersionId',
      'screenId',
      'routePattern',
      'observedRoute',
      'status',
      'stateFingerprint',
    ])
    .where('id', '=', driftReportId)
    .executeTakeFirst();

  if (row === undefined) return null;

  return { ...row, status: row.status as DriftStatus };
}

/** One screen as memory holds it. The state fingerprint is how the clone's copy is found again. */
export interface StoredScreen {
  readonly id: string;
  readonly routePattern: string;
  readonly stateFingerprint: string;
}

/**
 * The screen the report names, read from `screens` rather than taken from the report.
 *
 * The report carries a `stateFingerprint` too, but it is the one the *extension observed* — and a
 * modal or a moved focus is enough to make that differ from the one the screen is stored under.
 * The clone copies screens keyed on the stored value, so looking the candidate's screen up by the
 * observed one would find nothing and the diff would be applied to no screen at all.
 */
export async function findScreen(
  db: ScopedDatabase,
  screenId: string,
): Promise<StoredScreen | null> {
  const row = await db
    .selectFrom('screens')
    .select(['id', 'routePattern', 'stateFingerprint'])
    .where('id', '=', screenId)
    .executeTakeFirst();

  return row ?? null;
}

/** The same screen inside a candidate version, found on the identity the clone preserved. */
export async function findClonedScreen(
  db: ScopedDatabase,
  memoryVersionId: string,
  stateFingerprint: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('screens')
    .select('id')
    .where('memoryVersionId', '=', memoryVersionId)
    .where('stateFingerprint', '=', stateFingerprint)
    .executeTakeFirst();

  return row?.id ?? null;
}

/**
 * Every element memory holds for one screen.
 *
 * Deliberately not `loadIndexedElements`, which takes a named subset: a reconcile is asking what
 * changed on a whole screen, and a subset would report every element it did not ask about as
 * removed. Scoped by screen rather than by memory version because a screen *is* the unit the
 * report names, and two screens of the same version share element keys.
 */
export async function loadScreenElements(
  db: ScopedDatabase,
  screenId: string,
): Promise<StoredElement[]> {
  const rows = await db
    .selectFrom('elements')
    .select(['id', 'elementKey', 'fingerprint'])
    .where('screenId', '=', screenId)
    .orderBy('elementKey')
    .execute();

  return rows.map((row) => {
    const fingerprint = ElementFingerprint.safeParse(row.fingerprint);
    if (!fingerprint.success) {
      // The same refusal `loadIndexedElements` makes, for a sharper reason: a fingerprint that
      // does not parse cannot be scored, so the element would silently join `missing` and the
      // diff would propose deleting a control that is very likely still on the page.
      throw new PersistenceError(
        `the stored fingerprint for ${row.elementKey} does not match the contract: ` +
          fingerprint.error.issues.map((issue) => issue.message).join('; '),
      );
    }
    return { id: row.id, elementKey: row.elementKey, fingerprint: fingerprint.data };
  });
}

/**
 * Claim a report for reconciliation, or decline to touch it.
 *
 * Returns false when the report has already been decided. That guard is the point of this being
 * conditional: a duplicate delivery arriving after a human approved or rejected must not reopen
 * their decision, and `status` is the only record that the decision happened.
 *
 * A report already `reconciling` *is* claimable. A reconcile writes a candidate version and
 * nothing in the customer's application, so replaying one is safe, and the alternative — refusing
 * re-entry — would strand any report whose worker died mid-run in a state nothing can leave.
 */
export async function claimForReconcile(
  db: ScopedDatabase,
  driftReportId: string,
): Promise<boolean> {
  const claimed = await db
    .updateTable('driftReports')
    .set({ status: 'reconciling' satisfies DriftStatus })
    .where('id', '=', driftReportId)
    .where('status', 'in', ['open', 'reconciling'] satisfies DriftStatus[])
    .returning('id')
    .executeTakeFirst();

  return claimed !== undefined;
}

/** The candidate version a previous attempt left behind, if this report has been reconciled before. */
export async function previousCandidate(
  db: ScopedDatabase,
  driftReportId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('driftReports')
    .select('candidateMemoryVersionId')
    .where('id', '=', driftReportId)
    .executeTakeFirst();

  return row?.candidateMemoryVersionId ?? null;
}

export interface DiffRecord {
  readonly driftReportId: string;
  readonly diff: StructuralDiff;
  readonly candidateMemoryVersionId: string;
  readonly aliasMigrationRate: number;
}

/**
 * Attach the diff and the candidate it corresponds to, and hand the report to a human.
 *
 * All four columns move together, and `DriftReport`'s own refinement is why: a `diffed` report
 * must name the version approving it would activate. Writing the status first and the candidate
 * afterwards would leave a window in which the console could load a report that fails the
 * contract it is parsed against.
 *
 * Still conditional on the status, for the same reason the claim is: a human who rejected this
 * report while the browser was working has decided, and a late-arriving diff does not get to
 * reopen it.
 */
export async function recordDiff(db: ScopedDatabase, record: DiffRecord): Promise<boolean> {
  const written = await db
    .updateTable('driftReports')
    .set({
      diff: JSON.stringify(record.diff),
      candidateMemoryVersionId: record.candidateMemoryVersionId,
      aliasMigrationRate: record.aliasMigrationRate.toString(),
      status: 'diffed' satisfies DriftStatus,
    })
    .where('id', '=', record.driftReportId)
    .where('status', '=', 'reconciling' satisfies DriftStatus)
    .returning('id')
    .executeTakeFirst();

  return written !== undefined;
}

/**
 * Release a report a reconcile could not finish, so the next attempt can claim it.
 *
 * Back to `open` rather than to a failure state: there is no failure state for a report, and
 * inventing one would be inventing a way for drift to be dismissed without a human. The
 * observation that the page stopped matching memory is still true — only the attempt to explain
 * it failed.
 */
export async function releaseReport(db: ScopedDatabase, driftReportId: string): Promise<void> {
  await db
    .updateTable('driftReports')
    .set({ status: 'open' satisfies DriftStatus })
    .where('id', '=', driftReportId)
    .where('status', '=', 'reconciling' satisfies DriftStatus)
    .execute();
}

export interface CandidateWrite {
  readonly tenantId: string;
  /** The screen *inside the candidate version*. Never the source screen. */
  readonly screenId: string;
  readonly routePattern: string;
  /** Element keys nothing on the page scored highly enough to be. */
  readonly removedKeys: readonly string[];
  /** Elements that survived, with the fingerprint the page now presents. */
  readonly survived: readonly { elementKey: string; fingerprint: ElementFingerprintValue }[];
  /** Elements the page has that memory did not account for. */
  readonly added: readonly ElementFingerprintValue[];
  /** Every fingerprint observed on the page, which confidence is relative to. */
  readonly population: ScreenPopulation;
  /** What the page now hashes to. Written onto the screen, or approval changes nothing. */
  readonly structuralHash: string;
}

export interface CandidateCounts {
  readonly removed: number;
  readonly updated: number;
  readonly added: number;
}

/**
 * Apply what was observed to the cloned screen, so approving the report means activating a
 * version that already matches the application.
 *
 * ## The structural hash is part of the write, not a detail
 *
 * A candidate whose screen still carried the *old* hash would be approved, activated, and then
 * immediately raise the same drift report again on the tester's next settle — a loop that looks
 * like the reconcile did nothing. The hash is what drift is detected by, so relearning without
 * updating it relearns nothing.
 *
 * ## Removals cascade
 *
 * `nav_edges.trigger_element` is `ON DELETE CASCADE`, so an edge whose control is gone goes with
 * it. That is the same reasoning `clone.ts` gives for not repairing them: an edge is a claim that
 * clicking a specific control leads somewhere, and a control that no longer exists cannot.
 */
export async function applyToCandidate(
  db: ScopedDatabase,
  write: CandidateWrite,
): Promise<CandidateCounts> {
  if (write.removedKeys.length > 0) {
    await db
      .deleteFrom('elements')
      .where('screenId', '=', write.screenId)
      .where('elementKey', 'in', [...write.removedKeys])
      .execute();
  }

  // Survivors keep the key memory already knows them by — that key is the identity the clone was
  // joined on and the one the gateway migrates aliases through. Only the fingerprint moves.
  const updates: ElementInput[] = write.survived.map((element) => ({
    tenantId: write.tenantId,
    screenId: write.screenId,
    elementKey: element.elementKey,
    fingerprint: element.fingerprint,
    confidence: confidenceOf(element.fingerprint, write.population),
    // Stability is "re-resolved across memory versions", and surviving a reconcile is exactly
    // that evidence — the same meaning `job-runner.ts` gives it when a crawl re-finds an element.
    stability: 1,
  }));

  const taken = new Set([
    ...write.survived.map((element) => element.elementKey),
    ...(await db
      .selectFrom('elements')
      .select('elementKey')
      .where('screenId', '=', write.screenId)
      .execute()
      .then((rows) => rows.map((row) => row.elementKey))),
  ]);

  const minter = new ElementKeyMinter(write.routePattern);
  const insertions: ElementInput[] = write.added.map((fingerprint) => ({
    tenantId: write.tenantId,
    screenId: write.screenId,
    elementKey: freeKey(minter.mint(fingerprint), taken),
    fingerprint,
    confidence: confidenceOf(fingerprint, write.population),
    // New to this version, so there is no re-resolution to have observed. 0 is what no evidence
    // looks like, per `job-runner.ts`.
    stability: 0,
  }));

  await upsertElements(db, [...updates, ...insertions]);

  await db
    .updateTable('screens')
    .set({ structuralHash: write.structuralHash })
    .where('id', '=', write.screenId)
    .execute();

  return {
    removed: write.removedKeys.length,
    updated: updates.length,
    added: insertions.length,
  };
}

/**
 * An element key nothing on this screen is already using.
 *
 * `ElementKeyMinter` numbers the keys it mints among themselves, which is not enough here: it is
 * minting for *additions only*, against a screen that already holds the elements that survived. A
 * new "View" link would be minted `orders.list.view` and collide with the one already there —
 * violating `elements_screen_key_key` and failing the whole reconcile on a name clash.
 */
function freeKey(minted: string, taken: Set<string>): string {
  if (!taken.has(minted)) {
    taken.add(minted);
    return minted;
  }

  for (let ordinal = 2; ; ordinal += 1) {
    const candidate = `${minted}-${String(ordinal)}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/**
 * How much of a screen's learned vocabulary the proposed change would carry over.
 *
 * `AliasMigrationSummary` defines the rate as `migrated / (migrated + dropped)`, and 1 when the
 * screen had no aliases to carry — which is the common case early in an application's life and
 * must not read as "everything was lost".
 *
 * Counted against the *source* version's aliases, because that is the vocabulary at risk. The
 * gateway performs the actual migration at approval time and counts it again then; this is the
 * number a lead reads *before* deciding, and the two agree because both ask the same question of
 * the same element keys — the identity the clone is joined on.
 */
export async function aliasMigrationRate(
  db: ScopedDatabase,
  memoryVersionId: string,
  screenId: string,
  removedElementIds: readonly string[],
): Promise<number> {
  const rows = await db
    .selectFrom('aliases')
    .innerJoin('elements', 'elements.id', 'aliases.elementId')
    .select('aliases.elementId')
    .where('aliases.memoryVersionId', '=', memoryVersionId)
    .where('elements.screenId', '=', screenId)
    .execute();

  if (rows.length === 0) return 1;

  const dropped = new Set(removedElementIds);
  const migrated = rows.filter((row) => !dropped.has(row.elementId)).length;
  return migrated / rows.length;
}
