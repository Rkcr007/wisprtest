import type { Browser, Page } from 'playwright';
import type { DriftReconcileJob, StructuralDiff } from 'protocol';

import type { CollectedPage, CollectOptions } from '../crawl/collected.js';
import { populationOf } from '../crawl/confidence.js';
import { BUNDLE_GLOBAL, MARKER_ATTRIBUTE } from '../crawl/fingerprint-bundle.js';
import type { SecretResolver } from '../crawl/secrets.js';
import type { TenantDatabase } from '../db/pool.js';
import { failMemoryVersion } from '../db/memory-repository.js';
import { NavigationError } from '../errors.js';
import { findSeedApplication } from '../seed/repository.js';
import {
  createSeedPolicy,
  describe,
  SEED_VIEWPORT,
  withAuthenticatedPage,
  withDeadline,
} from '../seed/session.js';
import { cloneMemoryVersion } from './clone.js';
import { computeDiff, type ObservedElement } from './diff.js';
import type { DriftMatchOptions, DriftMatchResult } from './matched.js';
import {
  aliasMigrationRate,
  applyToCandidate,
  claimForReconcile,
  type CandidateCounts,
  findClonedScreen,
  findDriftReport,
  findScreen,
  findVersionViewport,
  loadScreenElements,
  previousCandidate,
  recordDiff,
  releaseReport,
} from './repository.js';

/**
 * Reconciliation: go and look at the screen that stopped matching, and write down what changed.
 *
 * The learning loop's middle step (ARCHITECTURE § 6). The extension noticed a structural hash it
 * did not recognise and raised a report; this navigates to the route that report names, extracts
 * what is there now, and produces two things — a `StructuralDiff` a human reads, and a candidate
 * memory version they can activate by approving it.
 *
 * ## It never interacts with the application
 *
 * Navigate, settle, extract, leave. `DriftReconcileJob` carries no `CrawlBounds` and the argument
 * for that is a safety property rather than an omission: with no clicking there is nothing to
 * constrain, so no missing configuration can let a reconcile press Delete. **Anything added here
 * that clicks collapses that argument**, and the job would need bounds that are not stored
 * anywhere — bounds arrive per crawl request and are never persisted.
 *
 * ## It builds; a human activates
 *
 * The candidate is left `building` and this module never calls `activateMemoryVersion`. Approval
 * belongs to the gateway, gated on `drift:approve`. "WisprTest proposes; a human commits" is not a
 * default to be relaxed — ADR 0007 and Phase 17 both forbid an auto-approve path, even behind a
 * flag, and the shape of this function is what makes one impossible to add by accident.
 *
 * ## Three phases, and why the database is not held across the browser
 *
 * Read, look, write. The browser work sits *between* two short transactions rather than inside
 * one long one: a page load and settle is seconds, and a transaction held open across it would
 * hold row locks on a report the console is trying to display for the whole time.
 */

/** How long to wait for the page to stop changing. Bounded; both timeouts failing is normal. */
const NETWORK_IDLE_TIMEOUT_MS = 5_000;
const SETTLE_DELAY_MS = 250;

/** Minimum score for a live element to *be* the element memory recorded. See `DriftMatchOptions`. */
const MATCH_THRESHOLD = 0.55;

/** The browser half did not finish inside the job's ceiling. A value, so nothing throws in a timer. */
const TIMED_OUT = Symbol('reconcile-timed-out');

export interface ReconcileDependencies {
  readonly database: TenantDatabase;
  readonly browser: Browser;
  readonly secrets: SecretResolver;
}

export type ReconcileOutcome = 'diffed' | 'skipped' | 'failed';

export interface ReconcileResult {
  readonly outcome: ReconcileOutcome;
  /** One line, no stack, no page content — this is logged and shown. Null when it worked. */
  readonly reason: string | null;
  readonly candidateMemoryVersionId: string | null;
  readonly diff: StructuralDiff | null;
  readonly aliasMigrationRate: number | null;
  /** What the candidate actually had written to it. Null unless a diff was produced. */
  readonly applied: CandidateCounts | null;
  readonly durationMs: number;
}

/** What the read phase gathers before a browser is opened. */
interface ReconcileContext {
  readonly memoryVersionId: string;
  readonly screenId: string;
  readonly stateFingerprint: string;
  readonly routePattern: string;
  readonly route: string;
  readonly stored: Awaited<ReturnType<typeof loadScreenElements>>;
  readonly application: NonNullable<Awaited<ReturnType<typeof findSeedApplication>>>;
  /**
   * The size to open the browser at, and to score against.
   *
   * The viewport the crawl measured at when the version records one, and `SEED_VIEWPORT` when it
   * does not. Stored bboxes are fractions of the viewport they were captured at, so comparing
   * them against a page rendered at a different width means comparing two different rulers — the
   * bbox signal then scores low for every element at once, not because anything moved.
   */
  readonly viewport: { readonly width: number; readonly height: number };
}

export async function reconcile(
  job: DriftReconcileJob,
  deps: ReconcileDependencies,
): Promise<ReconcileResult> {
  const started = performance.now();
  const done = (
    outcome: ReconcileOutcome,
    fields: Partial<Omit<ReconcileResult, 'outcome' | 'durationMs'>> = {},
  ): ReconcileResult => ({
    outcome,
    reason: null,
    candidateMemoryVersionId: null,
    diff: null,
    aliasMigrationRate: null,
    applied: null,
    ...fields,
    durationMs: performance.now() - started,
  });

  const context = await deps.database.withTenant(job.tenantId, async (db) => {
    const report = await findDriftReport(db, job.driftReportId);
    if (report === null) return 'unknown report' as const;

    // A report a human has already decided is not reopened by a job that arrives late. The status
    // is the only record that the decision happened.
    if (!(await claimForReconcile(db, job.driftReportId))) {
      return `report is ${report.status} and will not be reconciled again` as const;
    }

    const screen = await findScreen(db, report.screenId);
    if (screen === null) return 'the screen this report names is no longer in memory' as const;

    const application = await findSeedApplication(db, job.applicationId);
    if (application === null) return 'unknown application' as const;

    return {
      memoryVersionId: report.memoryVersionId,
      screenId: screen.id,
      stateFingerprint: screen.stateFingerprint,
      routePattern: screen.routePattern,
      route: report.observedRoute,
      stored: await loadScreenElements(db, screen.id),
      application,
      viewport: (await findVersionViewport(db, report.memoryVersionId)) ?? SEED_VIEWPORT,
    } satisfies ReconcileContext;
  });

  if (typeof context === 'string') return done('skipped', { reason: context });

  // The report goes back to `open` whenever the browser half does not produce an observation, so
  // another attempt can claim it. There is no failure state for a report, and inventing one would
  // be inventing a way for drift to be dismissed without a human: the observation that the page
  // stopped matching memory is still true, whatever went wrong trying to explain it.
  const failed = async (reason: string): Promise<ReconcileResult> => {
    await deps.database.withTenant(job.tenantId, (db) => releaseReport(db, job.driftReportId));
    return done('failed', { reason });
  };

  let observed: Observation | typeof TIMED_OUT;
  try {
    // `deadlineMs` is "a wall-clock ceiling for the whole reconcile", not for one navigation.
    // Playwright's per-action timeouts add up — a slow settle plus a slow collection can each be
    // within their own limit and together exceed the ceiling the gateway sized its wait against.
    observed = await withDeadline<Observation | typeof TIMED_OUT>(
      job.deadlineMs,
      observePage(job, context, deps),
      () => TIMED_OUT,
    );
  } catch (error: unknown) {
    return await failed(describe(error));
  }

  if (observed === TIMED_OUT) {
    return await failed(`the reconcile did not finish within ${String(job.deadlineMs)}ms`);
  }

  return await deps.database.withTenant(job.tenantId, async (db) => {
    const superseded = await previousCandidate(db, job.driftReportId);
    if (superseded !== null) {
      // A retry builds a fresh candidate. The one the previous attempt left is not deleted — a
      // half-built version is evidence about where that attempt failed — but it must not sit
      // `building` forever looking like a live proposal.
      await failMemoryVersion(db, superseded, 'superseded by a later reconcile of the same report');
    }

    const candidate = await cloneMemoryVersion(
      db,
      job.tenantId,
      job.applicationId,
      context.memoryVersionId,
    );

    const clonedScreen = await findClonedScreen(
      db,
      candidate.memoryVersionId,
      context.stateFingerprint,
    );
    if (clonedScreen === null) {
      await releaseReport(db, job.driftReportId);
      return done('failed', {
        reason: 'the cloned version does not hold the screen being reconciled',
      });
    }

    const storedById = new Map(context.stored.map((element) => [element.elementKey, element]));
    const observedByMarker = new Map(
      observed.elements.map((element) => [element.marker, element.fingerprint]),
    );

    const removedKeys = observed.match.missing.filter((key) => storedById.has(key));
    const removedIds = removedKeys.flatMap((key) => {
      const element = storedById.get(key);
      return element === undefined ? [] : [element.id];
    });

    const counts = await applyToCandidate(db, {
      tenantId: job.tenantId,
      screenId: clonedScreen,
      routePattern: context.routePattern,
      removedKeys,
      survived: observed.match.matched.flatMap((match) => {
        const fingerprint = observedByMarker.get(match.marker);
        return fingerprint === undefined ? [] : [{ elementKey: match.elementKey, fingerprint }];
      }),
      added: observed.match.unmatchedMarkers.flatMap((marker) => {
        const fingerprint = observedByMarker.get(marker);
        return fingerprint === undefined ? [] : [fingerprint];
      }),
      population: populationOf(observed.elements.map((element) => element.fingerprint)),
      structuralHash: observed.structuralHash,
    });

    const rate = await aliasMigrationRate(
      db,
      context.memoryVersionId,
      context.screenId,
      removedIds,
    );

    const written = await recordDiff(db, {
      driftReportId: job.driftReportId,
      diff: observed.diff,
      candidateMemoryVersionId: candidate.memoryVersionId,
      aliasMigrationRate: rate,
    });

    if (!written) {
      // A human decided while the browser was working. Their decision stands; the candidate this
      // run built is abandoned rather than attached to a report that has moved on.
      await failMemoryVersion(
        db,
        candidate.memoryVersionId,
        'the report was decided before this reconcile finished',
      );
      return done('skipped', { reason: 'the report was decided while it was being reconciled' });
    }

    return done('diffed', {
      candidateMemoryVersionId: candidate.memoryVersionId,
      diff: observed.diff,
      aliasMigrationRate: rate,
      applied: counts,
    });
  });
}

interface Observation {
  readonly elements: readonly ObservedElement[];
  readonly match: DriftMatchResult;
  readonly diff: StructuralDiff;
  readonly structuralHash: string;
}

/**
 * The browser half: navigate to the route, extract what is there, and score memory against it.
 *
 * Opened through `withAuthenticatedPage`, which is shared with the seed adapters rather than
 * reimplemented — it applies the application's auth profile and refuses any URL the SSRF policy
 * does not allow, and two copies of that would mean two chances to get the allowlist subtly wrong.
 */
async function observePage(
  job: DriftReconcileJob,
  context: ReconcileContext,
  deps: ReconcileDependencies,
): Promise<Observation> {
  const policy = createSeedPolicy(context.application, undefined);
  const target = new URL(context.route, context.application.baseUrl).toString();
  await policy.assertAllowed(target);

  return await withAuthenticatedPage(
    {
      application: context.application,
      policy,
      browser: deps.browser,
      secrets: deps.secrets,
      deadlineMs: job.deadlineMs,
      viewport: context.viewport,
    },
    async (page) => {
      const response = await page.goto(target, { waitUntil: 'domcontentloaded' });
      if (response !== null && !response.ok()) {
        throw new NavigationError(target, `the route returned HTTP ${String(response.status())}`);
      }

      // Redirects are followed by the browser, so the URL that was checked may not be the one that
      // loaded. Re-checking is what stops an open redirect being a way past the allowlist — the
      // same second check `crawler.ts` makes for the same reason.
      await policy.assertAllowed(page.url());

      await settle(page);

      const options: CollectOptions = {
        routePattern: context.routePattern,
        // A reconcile never interacts, so there is nothing for a never-interact list to prevent.
        // The collector still computes `interactable`; this run simply never acts on it.
        neverInteractSelectors: [],
        viewport: context.viewport,
        markerAttribute: MARKER_ATTRIBUTE,
      };

      const collected = await collectPage(page, options);
      const match = await matchStoredOnPage(page, {
        targets: context.stored.map((element) => ({
          elementKey: element.elementKey,
          fingerprint: element.fingerprint,
        })),
        viewport: context.viewport,
        markerAttribute: MARKER_ATTRIBUTE,
        threshold: MATCH_THRESHOLD,
      });

      const elements: ObservedElement[] = collected.elements.map((element) => ({
        marker: element.marker,
        fingerprint: element.fingerprint,
      }));

      return {
        elements,
        match,
        diff: computeDiff({ stored: context.stored, observed: elements, match }),
        structuralHash: collected.structuralHash,
      };
    },
  );
}

/**
 * Wait for the page to stop changing.
 *
 * Network idle, then a fixed delay. The delay is not redundant: idle means no requests are in
 * flight, and a framework that has just received its data still has to render it. Both are bounded
 * and both failing to arrive is normal — an application with a websocket or a polling timer never
 * reaches network idle at all, and waiting past the timeout would report the half-rendered page as
 * a screen that lost most of its controls.
 */
async function settle(page: Page): Promise<void> {
  await page
    .waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS })
    .catch(() => undefined);
  await page.waitForTimeout(SETTLE_DELAY_MS);
}

/** The shape the injected bundle installs on the page's global object. */
interface InPageApi {
  collect(options: CollectOptions): CollectedPage;
  matchStored(options: DriftMatchOptions): DriftMatchResult;
}

async function collectPage(page: Page, options: CollectOptions): Promise<CollectedPage> {
  try {
    return await page.evaluate<CollectedPage, { globalName: string; options: CollectOptions }>(
      ({ globalName, options: collectOptions }) => {
        const api = (globalThis as unknown as Record<string, InPageApi | undefined>)[globalName];
        if (api === undefined) throw new Error('the WisprTest collector was not injected');
        return api.collect(collectOptions);
      },
      { globalName: BUNDLE_GLOBAL, options },
    );
  } catch (error: unknown) {
    throw new NavigationError(page.url(), `in-page collection failed: ${describe(error)}`, {
      cause: error,
    });
  }
}

/**
 * Score every remembered element against the page, inside the page.
 *
 * Runs after {@link collectPage} and never before: it reads the markers that pass stamped, and
 * matching against markers from an earlier document would name elements that are no longer there.
 */
async function matchStoredOnPage(
  page: Page,
  options: DriftMatchOptions,
): Promise<DriftMatchResult> {
  try {
    return await page.evaluate<
      DriftMatchResult,
      { globalName: string; options: DriftMatchOptions }
    >(
      ({ globalName, options: matchOptions }) => {
        const api = (globalThis as unknown as Record<string, InPageApi | undefined>)[globalName];
        if (api === undefined) throw new Error('the WisprTest collector was not injected');
        return api.matchStored(matchOptions);
      },
      { globalName: BUNDLE_GLOBAL, options },
    );
  } catch (error: unknown) {
    throw new NavigationError(page.url(), `in-page matching failed: ${describe(error)}`, {
      cause: error,
    });
  }
}
