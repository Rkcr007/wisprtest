import { z } from 'zod';

import {
  Confidence,
  ElementKey,
  IsoDateTime,
  LatencyMs,
  NonEmptyString,
  RedactedText,
  RoutePath,
  RoutePattern,
  Sha256Hex,
  StateFingerprint,
  StructuralHash,
  Uuid,
} from './primitives.js';
import { contract } from './registry.js';

/**
 * Drift — the learning loop.
 *
 * The extension compares the live structural hash against memory on every route settle. A
 * mismatch never blocks the tester: it raises a report, shows a non-blocking notice, and the
 * session continues in degraded mode.
 *
 * A drift report is a *proposal*. Fully automatic self-healing is what destroyed trust in the
 * previous generation of QA tools — it made tests pass that should have failed. WisprTest
 * proposes; a human commits.
 */

/** An element present in the live page but absent from memory. */
export const ElementAddition = contract(
  'ElementAddition',
  z
    .strictObject({
      elementKey: ElementKey,
      role: NonEmptyString,
      accessibleNameRedacted: RedactedText,
      landmarkPath: z.array(NonEmptyString),
    })
    .describe('An element that appeared since the memory version was indexed.'),
);
export type ElementAddition = z.infer<typeof ElementAddition>;

/** An element in memory that no longer resolves in the live page. */
export const ElementRemoval = contract(
  'ElementRemoval',
  z
    .strictObject({
      elementKey: ElementKey,
      elementId: Uuid,
      role: NonEmptyString,
    })
    .describe('An element in memory that no longer exists in the live page.'),
);
export type ElementRemoval = z.infer<typeof ElementRemoval>;

/**
 * An element that still resolves but under a different ancestry. Aliases usually survive a
 * move, which is why it is tracked separately from an add plus a remove.
 */
export const ElementMove = contract(
  'ElementMove',
  z
    .strictObject({
      elementKey: ElementKey,
      elementId: Uuid,
      fromLandmarkPath: z.array(NonEmptyString),
      toLandmarkPath: z.array(NonEmptyString),
      /** Score of the moved element against its stored fingerprint. Gates alias migration. */
      matchConfidence: Confidence,
    })
    .describe('An element that survived but changed position in the landmark tree.'),
);
export type ElementMove = z.infer<typeof ElementMove>;

/**
 * An element whose accessible name changed. Only hashes and redacted forms cross this
 * boundary — a rename must never carry the raw before-and-after text.
 */
export const ElementRename = contract(
  'ElementRename',
  z
    .strictObject({
      elementKey: ElementKey,
      elementId: Uuid,
      fromNameHash: Sha256Hex,
      toNameHash: Sha256Hex,
      toNameRedacted: RedactedText,
      matchConfidence: Confidence,
    })
    .describe('An element whose accessible name changed between versions.'),
);
export type ElementRename = z.infer<typeof ElementRename>;

/**
 * A change to learned data knowledge found by re-running the schema observers over the changed
 * region — a new required field, a widened enum, a materializer that no longer verifies.
 */
export const SchemaChange = contract(
  'SchemaChange',
  z
    .strictObject({
      entity: NonEmptyString,
      kind: z.enum([
        'field_added',
        'field_removed',
        'field_type_changed',
        'required_changed',
        'enum_values_changed',
        'materializer_invalidated',
      ]),
      /** The field or materializer affected. Null for entity-level changes. */
      field: NonEmptyString.nullable(),
      /** Plain-language summary for the approval screen. */
      detail: NonEmptyString,
    })
    .describe('A change to a learned entity schema detected during reconciliation.'),
);
export type SchemaChange = z.infer<typeof SchemaChange>;

/**
 * What actually changed on a screen.
 *
 * Produced by the indexer after re-crawling only the changed region — never the whole app.
 * This is the diff a QA lead reads before approving a memory version increment.
 */
export const StructuralDiff = contract(
  'StructuralDiff',
  z
    .strictObject({
      added: z.array(ElementAddition),
      removed: z.array(ElementRemoval),
      moved: z.array(ElementMove),
      renamed: z.array(ElementRename),
      schemaChanges: z.array(SchemaChange),
    })
    .describe('The reviewable difference between memory and the live application.'),
);
export type StructuralDiff = z.infer<typeof StructuralDiff>;

/** Where a drift report came from: live detection in the extension, or a scheduled re-crawl. */
export const DriftDetector = contract(
  'DriftDetector',
  z.enum(['extension', 'indexer']).describe('Which component observed the structural mismatch.'),
);
export type DriftDetector = z.infer<typeof DriftDetector>;

/**
 * Lifecycle of a drift report.
 *
 * `open` → `reconciling` when the indexer picks it up → `diffed` once a `StructuralDiff` is
 * attached → `approved` or `rejected` by a human. There is no path that reaches `approved`
 * without a human, and none is to be added, even behind a flag.
 */
export const DriftStatus = contract(
  'DriftStatus',
  z
    .enum(['open', 'reconciling', 'diffed', 'approved', 'rejected'])
    .describe('Lifecycle state of a drift report.'),
);
export type DriftStatus = z.infer<typeof DriftStatus>;

/**
 * A proposal to change memory, raised by a structural hash mismatch.
 *
 * `aliasMigrationRate` is the fraction of this screen's aliases whose target still scored above
 * threshold after the change. A low rate means the tester's learned vocabulary is about to be
 * lost, and it is the number the approval screen leads with.
 */
export const DriftReport = contract(
  'DriftReport',
  z
    .strictObject({
      id: Uuid,
      tenantId: Uuid,
      /** The version this report is *about* — the one the live page stopped matching. */
      memoryVersionId: Uuid,
      /**
       * The version a reconcile built, waiting for a human to activate it.
       *
       * This is where the loop's work actually lives, and why the gateway's approval is four
       * status updates rather than a rewrite of memory. `StructuralDiff` cannot be applied by
       * whoever approves it: {@link ElementAddition} carries a redacted name and a landmark path,
       * which is what a human needs to read and nowhere near enough to write an `elements` row.
       * The fingerprint does not belong in a diff either — it is machine data in a field whose
       * whole purpose is being reviewable.
       *
       * So the indexer, which already knows how to write a memory version because that is what a
       * crawl does, clones the active one, applies what it observed, and leaves it `building`.
       * The diff stays the human-readable account of what changed. Approval flips a status.
       *
       * Null until reconciliation has produced one.
       */
      candidateMemoryVersionId: Uuid.nullable(),
      screenId: Uuid,
      routePattern: RoutePattern,
      /**
       * The concrete path the drift was seen at, kept so a reconcile can be retried.
       *
       * A pattern cannot be navigated to. The gateway enqueues the job when the report is raised
       * and could pass the route straight through, but then a job lost to a Redis outage would
       * strand the report `open` with nothing able to re-enqueue it.
       */
      observedRoute: RoutePath,
      stateFingerprint: StateFingerprint,
      expectedStructuralHash: StructuralHash,
      observedStructuralHash: StructuralHash,
      /** Null until the indexer has reconciled the changed region. */
      diff: StructuralDiff.nullable(),
      status: DriftStatus,
      detectedBy: DriftDetector,
      /** Null until a diff exists to compute it from. */
      aliasMigrationRate: Confidence.nullable(),
      /** The human who approved or rejected. Null while pending — always. */
      approvedBy: Uuid.nullable(),
      createdAt: IsoDateTime,
      resolvedAt: IsoDateTime.nullable(),
    })
    .refine(
      (report) =>
        (report.status !== 'open' && report.status !== 'reconciling') ||
        report.candidateMemoryVersionId === null,
      {
        error: 'a report nobody has reconciled yet cannot already have built a candidate version',
        path: ['candidateMemoryVersionId'],
      },
    )
    .refine((report) => report.status !== 'diffed' || report.candidateMemoryVersionId !== null, {
      error: 'a diffed report names the version approving it would activate',
      path: ['candidateMemoryVersionId'],
    })
    .describe('A proposed memory change raised by a structural mismatch, pending human review.'),
);
export type DriftReport = z.infer<typeof DriftReport>;

/* -------------------------------------------------------------------------------------------
 * The drift boundary: extension → gateway, gateway → indexer, gateway → console.
 * ---------------------------------------------------------------------------------------- */

/**
 * Whether a path is somewhere a browser can actually go.
 *
 * `RoutePath` and `RoutePattern` share a regex — both are "an absolute path with no whitespace" —
 * so the type system alone cannot tell `/orders/4903` from `/orders/:id`. Everywhere else that
 * distinction is carried by which field a value lands in, and nothing breaks if it is confused.
 *
 * Here it does break, and quietly: a reconcile navigates to this value, and a worker sent
 * `/orders/:id` fetches a 404, finds none of the elements memory expects, and reports that the
 * entire screen was removed. A diff proposing to delete a screen that is fine is exactly the
 * proposal a human should never be shown.
 *
 * Checked per segment rather than by searching for a colon: RFC 3986 permits `:` inside a path
 * segment, and only a segment that *begins* with one is a pattern placeholder.
 */
function isVisitablePath(route: string): boolean {
  return !route.split('/').some((segment) => segment.startsWith(':'));
}

/**
 * Raising a report. The extension noticed the page stopped matching memory.
 *
 * Sent on route settle when the live structural hash differs from the one the snapshot holds for
 * this screen. It is a *notification*, not a request for anything: the response is not awaited on
 * any path that blocks the tester, because § 6's learning loop runs in the background and
 * `BUILD-PLAN.md` Phase 17 is explicit that drift must never block.
 *
 * ## The memory version is read from the session, not sent
 *
 * The same discipline as {@link SeedPlanRequest}: a client that could name the version it is
 * reporting against could report drift against somebody else's. The session records which version
 * it opened with, and that is the only version this report can be about.
 *
 * ## Why a concrete route travels alongside the pattern
 *
 * `routePattern` says which screen drifted; it cannot say where to go and look. A reconcile has to
 * navigate somewhere, and `/orders/:id` is not somewhere. The concrete path the tester was on is
 * the only place that information exists, so it is captured here — it is an identifier in a URL,
 * the same class of data {@link UiSeedJob}'s revert variant already carries.
 */
export const DriftRaiseRequest = contract(
  'DriftRaiseRequest',
  z
    .strictObject({
      sessionId: Uuid,
      /** The screen whose stored hash no longer matches, as named by the snapshot. */
      screenId: Uuid,
      routePattern: RoutePattern,
      /** Where the tester actually was. What a reconcile navigates to. */
      route: RoutePath,
      stateFingerprint: StateFingerprint,
      expectedStructuralHash: StructuralHash,
      observedStructuralHash: StructuralHash,
      observedAt: IsoDateTime,
    })
    .refine((report) => report.expectedStructuralHash !== report.observedStructuralHash, {
      error: 'a report whose hashes agree is not drift',
      path: ['observedStructuralHash'],
    })
    .refine((report) => isVisitablePath(report.route), {
      error: 'route must be the path the tester was on, not the pattern it generalises to',
      path: ['route'],
    })
    .describe('The extension reporting that a screen no longer matches memory. Blocks nothing.'),
);
export type DriftRaiseRequest = z.infer<typeof DriftRaiseRequest>;

/**
 * What became of a raised report.
 *
 * `created` is false when an equivalent report was already open, and that is the ordinary case
 * rather than an edge one: a tester working on a drifted screen settles on it repeatedly, and each
 * settle raises again. Deduplicating server-side — rather than asking the extension to remember
 * what it has sent — keeps the rule in one place and survives a service worker restart.
 */
export const DriftRaiseResponse = contract(
  'DriftRaiseResponse',
  z
    .strictObject({
      report: DriftReport,
      /** False when this observation joined a report that already existed. */
      created: z.boolean(),
    })
    .describe('The report this observation belongs to, whether or not it created one.'),
);
export type DriftRaiseResponse = z.infer<typeof DriftRaiseResponse>;

/** Reports awaiting a human, newest first. The console's review queue. */
export const DriftListResponse = contract(
  'DriftListResponse',
  z
    .strictObject({
      reports: z.array(DriftReport),
      /** Reports matching the filter, which may exceed the page returned. */
      total: z.int().min(0),
    })
    .describe('Pending drift reports for one application.'),
);
export type DriftListResponse = z.infer<typeof DriftListResponse>;

/**
 * A human's decision on a report. The only thing that can change memory.
 *
 * `BUILD-PLAN.md` Phase 17 and [ADR 0007]: "Fully automatic self-healing is what destroyed trust
 * in the previous generation of QA tools — it made tests pass that should have failed. WisprTest
 * proposes; a human commits. Do not add an auto-approve path, even behind a flag."
 *
 * A rejection carries a reason and an approval does not, which is the asymmetry that matters: an
 * approved diff explains itself, because the diff *is* the explanation and it is stored. A
 * rejection discards a proposal the system believed in, and the next person to look at the same
 * drift deserves to know why the last one said no.
 */
export const DriftDecisionRequest = contract(
  'DriftDecisionRequest',
  z
    .discriminatedUnion('decision', [
      z.strictObject({ decision: z.literal('approve') }).meta({
        title: 'DriftApproval',
        description: 'Apply the diff, increment the memory version, and migrate what survives.',
      }),
      z.strictObject({ decision: z.literal('reject'), reason: NonEmptyString }).meta({
        title: 'DriftRejection',
        description: 'Leave memory as it is, and record why.',
      }),
    ])
    .describe('A human approving or rejecting a proposed memory change.'),
);
export type DriftDecisionRequest = z.infer<typeof DriftDecisionRequest>;

/**
 * What happened to a screen's learned vocabulary when a diff was applied.
 *
 * The number the approval screen leads with, per {@link DriftReport}'s `aliasMigrationRate`. An
 * alias survives when its element still resolves above threshold after the change; it is dropped
 * when the element it pointed at is gone or no longer recognisable.
 *
 * Dropping is reported, never silent. A tester whose phrasing stopped working is owed the reason,
 * and "seven of your forty phrases no longer resolve" is a thing a lead can decide about before
 * approving rather than discover afterwards.
 */
export const AliasMigrationSummary = contract(
  'AliasMigrationSummary',
  z
    .strictObject({
      migrated: z.int().min(0),
      dropped: z.int().min(0),
      /** `migrated / (migrated + dropped)`, and 1 when the screen had no aliases to carry. */
      rate: Confidence,
    })
    .describe("How much of a screen's learned vocabulary survived a memory change."),
);
export type AliasMigrationSummary = z.infer<typeof AliasMigrationSummary>;

/**
 * The outcome of a decision.
 *
 * `newMemoryVersionId` is populated only by an approval, and it is the point of the whole loop:
 * approving a diff does not edit the active version in place, it creates the next one. The old
 * version stays exactly as it was, so a session that was resolving against it keeps working and a
 * bad approval is a version to roll back rather than a change to reconstruct.
 */
export const DriftDecisionResponse = contract(
  'DriftDecisionResponse',
  z
    .strictObject({
      report: DriftReport,
      /** The version the approved diff produced. Null on a rejection. */
      newMemoryVersionId: Uuid.nullable(),
      /** Null on a rejection: nothing moved, so there is nothing to summarise. */
      aliasMigration: AliasMigrationSummary.nullable(),
    })
    .refine(
      (response) => (response.newMemoryVersionId === null) === (response.aliasMigration === null),
      {
        error: 'a new version reports what its aliases did; a rejection reports neither',
        path: ['aliasMigration'],
      },
    )
    .describe("What a human's decision did to memory."),
);
export type DriftDecisionResponse = z.infer<typeof DriftDecisionResponse>;

/**
 * Work for the indexer: re-crawl one screen and say what changed.
 *
 * ## This job never interacts with the application
 *
 * A crawl clicks — that is how it derives nav edges, and it is why {@link CrawlBounds} requires a
 * never-interact list before a browser is allowed to start. A reconcile does not: it navigates to
 * one route, waits for it to settle, extracts fingerprints, computes a structural hash, and
 * leaves. The schema observers run on what that navigation produced, which is markup and whatever
 * the page fetched, and none of them need a click either.
 *
 * So this job carries no bounds, and that is a safety property rather than an omission. There is
 * no interaction to constrain, so there is no configuration whose absence could permit a
 * reconcile to press Delete. It also means a reconcile can run for an application whose crawl
 * bounds nobody has stored, which is every application — bounds are supplied per crawl request
 * and are not persisted.
 *
 * ## Ids, not data
 *
 * The same rule as {@link SeedJob}: the worker loads the application, its auth profile and the
 * screen's stored elements itself. A job that carried fingerprints would put them in a Redis
 * stream and would be a second copy of memory that could disagree with the first.
 */
export const DriftReconcileJob = contract(
  'DriftReconcileJob',
  z
    .strictObject({
      jobId: Uuid,
      tenantId: Uuid,
      applicationId: Uuid,
      /** The version being reconciled *against*. The diff is expressed relative to it. */
      memoryVersionId: Uuid,
      driftReportId: Uuid,
      screenId: Uuid,
      routePattern: RoutePattern,
      /** Where to navigate. A pattern cannot be visited; this is the path that was observed. */
      route: RoutePath,
      /** Wall-clock ceiling for the whole reconcile, including the observers. */
      deadlineMs: LatencyMs,
      /** W3C `traceparent` of the request that enqueued it, or null when untraced. */
      traceparent: NonEmptyString.nullable(),
    })
    .refine((job) => isVisitablePath(job.route), {
      error: 'route must be a path the worker can navigate to, not the pattern it generalises to',
      path: ['route'],
    })
    .describe('Re-crawl one drifted screen, without interacting with it, and diff the result.'),
);
export type DriftReconcileJob = z.infer<typeof DriftReconcileJob>;
