import {
  DriftReport as DriftReportContract,
  StructuralDiff as StructuralDiffContract,
  type DriftReport,
  type DriftStatus,
} from 'protocol';

import { GatewayError } from '../errors.js';
import type { ScopedDatabase } from './pool.js';

/**
 * The reads and writes behind `/v1/drift`.
 *
 * Like the other repositories here, nothing writes a `where tenant_id = …`: row-level security
 * applies it, and a duplicated filter is one that can drift from the policy.
 *
 * ## What a report is, and what it is not
 *
 * A report is a *proposal*, and the work it proposes lives somewhere else. The reconcile worker
 * clones the active memory version, applies what it observed and leaves the clone `building`;
 * this table holds the pointer to that clone plus the human-readable account of what changed.
 * That is why approving is four status updates here rather than a rewrite of memory — see
 * `db/migrations/20260805120000_drift_candidate_and_route.sql` for the full reasoning.
 */

/** The statuses that mean a report is still in play, and therefore deduplicates a new sighting. */
const LIVE_STATUSES: readonly DriftStatus[] = ['open', 'reconciling', 'diffed'];

interface DriftRow {
  readonly id: string;
  readonly tenantId: string;
  readonly memoryVersionId: string;
  readonly candidateMemoryVersionId: string | null;
  readonly screenId: string;
  readonly routePattern: string;
  readonly observedRoute: string;
  readonly stateFingerprint: string;
  readonly expectedStructuralHash: string;
  readonly observedStructuralHash: string;
  readonly diff: unknown;
  readonly status: string;
  readonly detectedBy: string;
  readonly aliasMigrationRate: string | number | null;
  readonly approvedBy: string | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

const COLUMNS = [
  'id',
  'tenantId',
  'memoryVersionId',
  'candidateMemoryVersionId',
  'screenId',
  'routePattern',
  'observedRoute',
  'stateFingerprint',
  'expectedStructuralHash',
  'observedStructuralHash',
  'diff',
  'status',
  'detectedBy',
  'aliasMigrationRate',
  'approvedBy',
  'createdAt',
  'resolvedAt',
] as const;

/**
 * A stored row as the contract describes it.
 *
 * The parse is the check, not a formality: `diff` and `alias_migration_rate` are written by the
 * indexer, so this is the boundary where a diff produced by an older reconciler stops being
 * assumed to match the shape this build renders.
 */
function toDriftReport(row: DriftRow): DriftReport {
  const parsed = DriftReportContract.safeParse({
    id: row.id,
    tenantId: row.tenantId,
    memoryVersionId: row.memoryVersionId,
    candidateMemoryVersionId: row.candidateMemoryVersionId,
    screenId: row.screenId,
    routePattern: row.routePattern,
    observedRoute: row.observedRoute,
    stateFingerprint: row.stateFingerprint,
    expectedStructuralHash: row.expectedStructuralHash,
    observedStructuralHash: row.observedStructuralHash,
    diff: row.diff === null ? null : StructuralDiffContract.parse(row.diff),
    status: row.status,
    detectedBy: row.detectedBy,
    aliasMigrationRate: row.aliasMigrationRate === null ? null : Number(row.aliasMigrationRate),
    approvedBy: row.approvedBy,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  });

  if (!parsed.success) {
    throw new GatewayError('internal', 'a stored drift report does not match the contract', {
      driftReportId: row.id,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
      ),
    });
  }

  return parsed.data;
}

export interface RaiseDriftInput {
  readonly tenantId: string;
  readonly memoryVersionId: string;
  readonly screenId: string;
  readonly routePattern: string;
  readonly observedRoute: string;
  readonly stateFingerprint: string;
  readonly expectedStructuralHash: string;
  readonly observedStructuralHash: string;
}

/**
 * The report an observation belongs to, creating one only if nothing equivalent is in play.
 *
 * Deduplicated on `(memory_version_id, screen_id, observed_structural_hash)` across the statuses
 * that are still live. That triple is the identity of the *change*, not of the sighting: a tester
 * working on a drifted screen settles on it repeatedly and each settle raises again, and every one
 * of those is the same fact.
 *
 * A page that drifts *again* — to a third hash — is a different change and gets its own report,
 * which is correct: the candidate version the first reconcile built no longer describes what is
 * live, and a human needs to see both.
 *
 * The screen is verified to belong to the version before anything is written. Without it a client
 * could hang a report off another application's screen and the FK would happily accept it, since
 * both rows are inside the same tenant.
 */
export async function raiseDriftReport(
  db: ScopedDatabase,
  input: RaiseDriftInput,
): Promise<{ readonly report: DriftReport; readonly created: boolean }> {
  const screen = await db
    .selectFrom('screens')
    .select(['id'])
    .where('id', '=', input.screenId)
    .where('memoryVersionId', '=', input.memoryVersionId)
    .executeTakeFirst();

  if (screen === undefined) {
    throw new GatewayError('validation_failed', 'unknown screen for this memory version', {
      issues: [
        { path: 'screenId', message: 'no such screen in the memory version this session opened' },
      ],
    });
  }

  const existing = await db
    .selectFrom('driftReports')
    .select(COLUMNS)
    .where('memoryVersionId', '=', input.memoryVersionId)
    .where('screenId', '=', input.screenId)
    .where('observedStructuralHash', '=', input.observedStructuralHash)
    .where('status', 'in', [...LIVE_STATUSES])
    .orderBy('createdAt', 'desc')
    .executeTakeFirst();

  if (existing !== undefined) {
    return { report: toDriftReport(existing), created: false };
  }

  const inserted = await db
    .insertInto('driftReports')
    .values({
      tenantId: input.tenantId,
      memoryVersionId: input.memoryVersionId,
      screenId: input.screenId,
      routePattern: input.routePattern,
      observedRoute: input.observedRoute,
      stateFingerprint: input.stateFingerprint,
      expectedStructuralHash: input.expectedStructuralHash,
      observedStructuralHash: input.observedStructuralHash,
      status: 'open',
      detectedBy: 'extension',
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();

  return { report: toDriftReport(inserted), created: true };
}

/** Reports still awaiting a human, newest first, with the count before paging. */
export async function listPendingReports(
  db: ScopedDatabase,
  applicationId: string,
  limit: number,
): Promise<{ readonly reports: readonly DriftReport[]; readonly total: number }> {
  // Joined through `memory_versions` rather than filtered on a denormalised application id: a
  // report belongs to a version, and the version is what knows which application it indexes.
  const rows = await db
    .selectFrom('driftReports')
    .innerJoin('memoryVersions', 'memoryVersions.id', 'driftReports.memoryVersionId')
    .select(COLUMNS.map((column) => `driftReports.${column}` as const))
    .where('memoryVersions.applicationId', '=', applicationId)
    .where('driftReports.status', 'in', [...LIVE_STATUSES])
    .orderBy('driftReports.createdAt', 'desc')
    .limit(limit)
    .execute();

  const counted = await db
    .selectFrom('driftReports')
    .innerJoin('memoryVersions', 'memoryVersions.id', 'driftReports.memoryVersionId')
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .where('memoryVersions.applicationId', '=', applicationId)
    .where('driftReports.status', 'in', [...LIVE_STATUSES])
    .executeTakeFirst();

  return {
    reports: rows.map((row) => toDriftReport(row as unknown as DriftRow)),
    total: Number(counted?.total ?? 0),
  };
}

/** One report, or null when it belongs to another tenant or does not exist. */
export async function findDriftReport(db: ScopedDatabase, id: string): Promise<DriftReport | null> {
  const row = await db
    .selectFrom('driftReports')
    .select(COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();

  return row === undefined ? null : toDriftReport(row);
}

/* -------------------------------------------------------------------------------- deciding -- */

export interface ApprovalOutcome {
  readonly report: DriftReport;
  readonly newMemoryVersionId: string;
  readonly migrated: number;
  readonly dropped: number;
  /** The version number the snapshot cache is keyed by, so the caller can drop the old entry. */
  readonly supersededVersion: number;
  readonly applicationId: string;
}

/**
 * Activate the version a reconcile built, and carry across the vocabulary that survived.
 *
 * Every statement here belongs to one transaction, and the reason is
 * `memory_versions_one_active_per_application`: a partial unique index over `status = 'active'`.
 * Between superseding the old version and activating the new one there is an instant with no
 * active version at all, and a snapshot load landing in it would tell a tester their application
 * has never been indexed. Inside a transaction that instant is not observable.
 *
 * ## Aliases are migrated by phrase, not by element
 *
 * An alias points at an element id, and the candidate version's elements are new rows with new
 * ids — so nothing can be carried by pointer. What is stable across a clone is
 * `(screen.state_fingerprint, element.element_key)`, which is exactly what the two unique
 * constraints in the schema are built on, so the join below is the identity the database already
 * enforces rather than a heuristic.
 *
 * An alias whose element has no counterpart in the candidate version is **dropped, and counted**.
 * That is the number `AliasMigrationSummary` reports and the approval screen leads with: a tester
 * whose phrasing stopped working is owed the reason, and "seven of your forty phrases no longer
 * resolve" is something a lead can weigh before approving rather than discover afterwards.
 *
 * ## Two migration rates, deliberately not the same number
 *
 * `DriftReport.aliasMigrationRate` is written by the reconciler and is about *the drifted screen*:
 * it is the prediction a reviewer reads before deciding, and it is the number that means something,
 * because a screen that lost half its vocabulary is the case worth hesitating over.
 *
 * The {@link AliasMigrationSummary} returned here is about *the whole version*, because that is
 * what activation actually moved. A version is cloned wholesale and one screen changed, so
 * everything hanging off the untouched screens migrates trivially and this rate sits close to 1
 * almost always. It is a record of what happened, not a signal — do not surface it as though it
 * were the first number.
 */
export async function approveDriftReport(
  db: ScopedDatabase,
  report: DriftReport,
  approvedBy: string,
): Promise<ApprovalOutcome> {
  const candidateId = report.candidateMemoryVersionId;
  if (candidateId === null) {
    // Unreachable: the route checks status first, and both the contract and a CHECK constraint
    // require a diffed report to name one. Checked because approving nothing would report success
    // while leaving the application on the memory the tester already knows is wrong.
    throw new GatewayError(
      'validation_failed',
      'this report has no reconciled version to activate',
      {
        issues: [{ path: 'id', message: 'the report has not been reconciled yet' }],
      },
    );
  }

  const candidate = await db
    .selectFrom('memoryVersions')
    .select(['id', 'applicationId', 'version', 'status'])
    .where('id', '=', candidateId)
    .executeTakeFirst();

  if (candidate === undefined) {
    throw new GatewayError('validation_failed', 'the reconciled version no longer exists', {
      issues: [{ path: 'id', message: 'the candidate memory version has been deleted' }],
    });
  }
  if (candidate.status !== 'building') {
    // Already activated, superseded, or failed. Approving again would either be a no-op reported
    // as a change, or would resurrect a version somebody deliberately moved on from.
    throw new GatewayError('validation_failed', 'the reconciled version is no longer pending', {
      issues: [{ path: 'id', message: `the candidate version is ${candidate.status}` }],
    });
  }

  const current = await db
    .selectFrom('memoryVersions')
    .select(['id', 'version'])
    .where('applicationId', '=', candidate.applicationId)
    .where('status', '=', 'active')
    .executeTakeFirst();

  // Aliases first, while the version they point at is still the active one. Ordering matters only
  // for readability — the transaction makes it atomic either way — but reading it in the order the
  // work happens is worth more than saving a statement.
  const migrated = await db
    .insertInto('aliases')
    .columns([
      'tenantId',
      'memoryVersionId',
      'phrase',
      'elementId',
      'stateFingerprint',
      'source',
      'hits',
    ])
    .expression((eb) =>
      eb
        .selectFrom('aliases as old')
        .innerJoin('elements as oldElement', 'oldElement.id', 'old.elementId')
        .innerJoin('screens as oldScreen', 'oldScreen.id', 'oldElement.screenId')
        // The identity that survives a clone: same screen fingerprint, same element key.
        .innerJoin('screens as newScreen', (join) =>
          join
            .onRef('newScreen.stateFingerprint', '=', 'oldScreen.stateFingerprint')
            .on('newScreen.memoryVersionId', '=', candidateId),
        )
        .innerJoin('elements as newElement', (join) =>
          join
            .onRef('newElement.screenId', '=', 'newScreen.id')
            .onRef('newElement.elementKey', '=', 'oldElement.elementKey'),
        )
        .select((selected) => [
          'old.tenantId',
          selected.val(candidateId).as('memoryVersionId'),
          'old.phrase',
          'newElement.id as elementId',
          'old.stateFingerprint',
          'old.source',
          'old.hits',
        ])
        .where('old.memoryVersionId', '=', report.memoryVersionId),
    )
    .execute();

  const total = await db
    .selectFrom('aliases')
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .where('memoryVersionId', '=', report.memoryVersionId)
    .executeTakeFirst();

  const before = Number(total?.total ?? 0);

  if (current !== undefined) {
    await db
      .updateTable('memoryVersions')
      .set({ status: 'superseded' })
      .where('id', '=', current.id)
      .execute();
  }

  await db
    .updateTable('memoryVersions')
    .set({ status: 'active', approvedBy })
    .where('id', '=', candidateId)
    .execute();

  const updated = await db
    .updateTable('driftReports')
    .set({ status: 'approved', approvedBy, resolvedAt: new Date() })
    .where('id', '=', report.id)
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();

  const carried = Number(migrated[0]?.numInsertedOrUpdatedRows ?? 0n);

  return {
    report: toDriftReport(updated),
    newMemoryVersionId: candidateId,
    migrated: carried,
    dropped: Math.max(0, before - carried),
    supersededVersion: current?.version ?? candidate.version,
    applicationId: candidate.applicationId,
  };
}

/**
 * Record that a human said no.
 *
 * The candidate version is left exactly where it is, `building`. It is not deleted: it is the
 * evidence of what was proposed, it costs nothing while inactive because the partial unique index
 * only constrains `active`, and a reviewer who rejects and changes their mind should not have to
 * pay for a re-crawl. Cleaning up superseded and abandoned versions is a retention policy, not a
 * rejection's job.
 */
export async function rejectDriftReport(
  db: ScopedDatabase,
  reportId: string,
  rejectedBy: string,
): Promise<DriftReport> {
  const updated = await db
    .updateTable('driftReports')
    .set({ status: 'rejected', approvedBy: rejectedBy, resolvedAt: new Date() })
    .where('id', '=', reportId)
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();

  return toDriftReport(updated);
}
