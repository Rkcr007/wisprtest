import { lookup } from 'node:dns/promises';

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Browser } from 'playwright';
import type { CrawlJob, NavPrecondition } from 'protocol';

import { applyFormLogin, prepareAuth } from './crawl/auth.js';
import { openSession } from './crawl/browser.js';
import {
  crawl,
  type CrawlHandlers,
  type CrawlSummary,
  type IndexedScreen,
} from './crawl/crawler.js';
import { createRateLimiter } from './crawl/rate-limiter.js';
import { createUrlPolicy, type AddressLookup } from './crawl/url-policy.js';
import type { SecretResolver } from './crawl/secrets.js';
import type { TenantDatabase } from './db/pool.js';
import {
  activateMemoryVersion,
  countMemoryVersionContents,
  failMemoryVersion,
  findApplication,
  findPreviousMemoryVersion,
  listElementKeysForState,
  listIndexedScreens,
  openMemoryVersion,
  upsertElements,
  upsertNavEdge,
  upsertScreen,
} from './db/memory-repository.js';
import {
  BoundsError,
  CancelledError,
  failureCodeOf,
  failureDetailOf,
  SsrfError,
} from './errors.js';
import { createCheckpointStore } from './redis/checkpoint.js';
import { createProgressReporter } from './redis/progress.js';
import type { IndexerMetrics } from './telemetry/metrics.js';

/**
 * Running one crawl job, end to end.
 *
 * The order below is not incidental — each step exists to make a specific failure impossible:
 *
 * 1. **Read the application from the database** and check the job's base URL against the origin
 *    registered for it. The job payload says where to crawl; the database says where this
 *    application *is*. Requiring them to agree means a forged or stale job cannot point the
 *    crawler at somebody else's host even if it passes schema validation.
 * 2. **Open the memory version**, adopting a `building` one if a previous attempt left it behind.
 * 3. **Resolve auth and launch the context.** Credentials are resolved here, used immediately,
 *    and never stored.
 * 4. **Crawl**, persisting each route as it completes.
 * 5. **Activate** the version, or mark it `failed` with a reason an operator can read.
 *
 * ## Cancellation is not failure
 *
 * A worker shutting down mid-crawl leaves the version `building`, does not acknowledge the job,
 * and keeps the checkpoint. Another worker reclaims the entry once it has been idle long enough
 * and carries on from the last completed route. A *failure* is different: the version is marked
 * `failed`, the job is acknowledged, and nothing is retried automatically — a crawl that failed
 * on authentication will fail again, and a retry loop against a customer's login form is how you
 * get an account locked.
 */

export interface JobRunnerDependencies {
  readonly database: TenantDatabase;
  readonly redis: Redis;
  readonly browser: Browser;
  readonly secrets: SecretResolver;
  readonly metrics: IndexerMetrics;
  readonly logger: Logger;
  readonly progressMaxLength: number;
  /** Injected so tests can drive the SSRF policy without a resolver. */
  readonly addressLookup?: AddressLookup;
}

export interface JobOutcome {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly memoryVersionId: string | null;
  readonly summary?: CrawlSummary;
  readonly failure?: { readonly code: string; readonly detail: string };
}

const defaultLookup: AddressLookup = async (hostname) => {
  const results = await lookup(hostname, { all: true });
  return results.map((entry) => entry.address);
};

export async function runJob(
  job: CrawlJob,
  deps: JobRunnerDependencies,
  signal: AbortSignal,
): Promise<JobOutcome> {
  const startedAt = performance.now();
  const logger = deps.logger.child({
    tenant_id: job.tenantId,
    job_id: job.jobId,
    application_id: job.applicationId,
  });

  const progress = createProgressReporter(deps.redis, job.tenantId, job.jobId, {
    maxLength: deps.progressMaxLength,
    onError: (error: unknown) => {
      logger.warn({ event: 'progress.publish_failed', err: error }, 'progress event dropped');
    },
  });
  const checkpoints = createCheckpointStore(deps.redis, job.tenantId, job.jobId, (error) => {
    logger.warn({ event: 'checkpoint.failed', err: error }, 'checkpoint could not be written');
  });

  let memoryVersionId: string | null = null;

  try {
    const application = await deps.database.withTenant(job.tenantId, (db) =>
      findApplication(db, job.applicationId),
    );
    if (application === null) {
      throw new BoundsError([`application ${job.applicationId} does not exist in this tenant`]);
    }
    assertJobTargetsApplication(job, application.baseUrl);

    const policy = createUrlPolicy(job.bounds, deps.addressLookup ?? defaultLookup);
    // The entry point is checked before anything is launched: a job whose own base URL fails the
    // policy is misconfigured, and finding that out after a browser start is a wasted minute.
    await policy.assertAllowed(job.baseUrl);

    const version = await deps.database.withTenant(job.tenantId, (db) =>
      openMemoryVersion(db, job.tenantId, job.applicationId),
    );
    memoryVersionId = version.id;

    await progress.emit({
      kind: 'job_started',
      memoryVersionId: version.id,
      version: version.version,
      resumed: version.resumed,
    });
    logger.info(
      {
        event: 'job.started',
        memory_version_id: version.id,
        version: version.version,
        resumed: version.resumed,
      },
      'crawl job started',
    );

    const { alreadyIndexed, previousVersionId } = await deps.database.withTenant(
      job.tenantId,
      async (db) => ({
        alreadyIndexed: new Map(
          (await listIndexedScreens(db, version.id)).map((screen) => [
            screen.stateFingerprint,
            screen.id,
          ]),
        ),
        previousVersionId: await findPreviousMemoryVersion(db, job.applicationId, version.id),
      }),
    );

    const auth = await prepareAuth(job.authProfile, deps.secrets);
    const session = await openSession({ browser: deps.browser, bounds: job.bounds, auth });

    let summary: CrawlSummary;
    try {
      await applyFormLogin({
        page: session.page,
        profile: job.authProfile,
        baseUrl: job.baseUrl,
        bounds: job.bounds,
        policy,
        resolver: deps.secrets,
      });

      const checkpoint = await checkpoints.load();
      const resumeFrom =
        checkpoint !== null && checkpoint.memoryVersionId === version.id
          ? { frontier: checkpoint.frontier, visited: checkpoint.visited }
          : undefined;

      summary = await crawl({
        page: session.page,
        bounds: job.bounds,
        baseUrl: job.baseUrl,
        policy,
        limiter: createRateLimiter(job.bounds.requestsPerMinute),
        alreadyIndexed,
        ...(resumeFrom === undefined ? {} : { resumeFrom }),
        signal,
        handlers: createHandlers({
          job,
          memoryVersionId: version.id,
          previousVersionId,
          deps,
          progress,
          checkpoints,
        }),
      });
    } finally {
      await session.close();
    }

    const counts = await deps.database.withTenant(job.tenantId, async (db) => {
      await activateMemoryVersion(db, job.applicationId, version.id);
      return countMemoryVersionContents(db, version.id);
    });

    const durationMs = performance.now() - startedAt;
    await progress.emit({
      kind: 'job_completed',
      memoryVersionId: version.id,
      screenCount: counts.screens,
      elementCount: counts.elements,
      edgeCount: counts.edges,
      durationMs,
    });
    await checkpoints.clear();

    deps.metrics.jobsTotal.add(1, { outcome: 'completed' });
    deps.metrics.jobDurationMs.record(durationMs);
    logger.info(
      {
        event: 'job.completed',
        memory_version_id: version.id,
        screens: counts.screens,
        elements: counts.elements,
        edges: counts.edges,
        skipped: summary.routesSkipped,
        duration_ms: Math.round(durationMs),
      },
      'crawl job completed',
    );

    return { status: 'completed', memoryVersionId: version.id, summary };
  } catch (error: unknown) {
    const durationMs = performance.now() - startedAt;

    if (error instanceof CancelledError) {
      // Left `building` on purpose: the reclaiming worker adopts this version and continues.
      deps.metrics.jobsTotal.add(1, { outcome: 'cancelled' });
      logger.warn(
        { event: 'job.cancelled', memory_version_id: memoryVersionId },
        'crawl job cancelled; leaving it reclaimable',
      );
      return { status: 'cancelled', memoryVersionId };
    }

    const code = failureCodeOf(error);
    const detail = failureDetailOf(error);

    const failedVersionId = memoryVersionId;
    if (failedVersionId !== null) {
      await deps.database
        .withTenant(job.tenantId, (db) =>
          failMemoryVersion(db, failedVersionId, `${code}: ${detail}`),
        )
        .catch((persistError: unknown) => {
          logger.error(
            { event: 'job.fail_write_failed', err: persistError },
            'could not record the failure on the memory version',
          );
        });
    }

    await progress.emit({ kind: 'job_failed', memoryVersionId, code, detail });
    await checkpoints.clear();

    deps.metrics.jobsTotal.add(1, { outcome: 'failed', code });
    deps.metrics.jobDurationMs.record(durationMs);
    logger.error(
      {
        event: 'job.failed',
        memory_version_id: memoryVersionId,
        code,
        detail,
        duration_ms: Math.round(durationMs),
      },
      'crawl job failed',
    );

    return { status: 'failed', memoryVersionId, failure: { code, detail } };
  }
}

/**
 * The job may only crawl the application it names.
 *
 * The registered `base_url` is the authority. A job carrying a different origin is either stale —
 * the application was re-pointed after it was enqueued — or forged, and neither is a reason to
 * dial the host it asks for. The same rule covers the bounds: an origin allowlist that does not
 * include the application's own origin describes a crawl of somewhere else.
 */
function assertJobTargetsApplication(job: CrawlJob, registeredBaseUrl: string): void {
  const registered = new URL(registeredBaseUrl).origin;
  const requested = new URL(job.baseUrl).origin;

  if (registered !== requested) {
    throw new SsrfError(job.baseUrl, `job origin does not match the registered application origin`);
  }

  const allowed = job.bounds.allowedOrigins.some((origin) => new URL(origin).origin === registered);
  if (!allowed) {
    throw new BoundsError([
      "allowedOrigins does not include the application's own origin, so the crawl could not start",
    ]);
  }
}

interface HandlerOptions {
  readonly job: CrawlJob;
  readonly memoryVersionId: string;
  readonly previousVersionId: string | null;
  readonly deps: JobRunnerDependencies;
  readonly progress: ReturnType<typeof createProgressReporter>;
  readonly checkpoints: ReturnType<typeof createCheckpointStore>;
}

/**
 * Persistence and progress, wired to the crawler.
 *
 * Each screen is written in its own transaction. A crawl of two hundred routes inside one
 * transaction would hold locks for its whole duration and lose everything on any failure — which
 * is the opposite of resumable.
 */
function createHandlers(options: HandlerOptions): CrawlHandlers {
  const { job, deps, progress, checkpoints, memoryVersionId } = options;
  const elementIdsByKey = new Map<string, string>();
  let routeStartedAt = performance.now();

  return {
    async routeStarted(path: string, depth: number): Promise<void> {
      routeStartedAt = performance.now();
      await progress.emit({ kind: 'route_started', path, depth });
    },

    async routeSkipped(path, reason): Promise<void> {
      deps.metrics.routesTotal.add(1, { outcome: 'skipped', reason });
      await progress.emit({ kind: 'route_skipped', path, reason });
    },

    async screenIndexed(screen: IndexedScreen): Promise<string> {
      const screenId = await deps.database.withTenant(job.tenantId, async (db) => {
        const id = await upsertScreen(db, {
          tenantId: job.tenantId,
          memoryVersionId,
          routePattern: screen.routePattern,
          stateFingerprint: screen.stateFingerprint,
          label: screen.label,
          structuralHash: screen.structuralHash,
        });

        // Stability is "re-resolution rate across previous memory versions" — so it is read from
        // the previous version rather than assumed. With no previous version there is no
        // evidence, and 0 is what no evidence looks like.
        const previousKeys =
          options.previousVersionId === null
            ? new Set<string>()
            : await listElementKeysForState(db, options.previousVersionId, screen.stateFingerprint);

        const ids = await upsertElements(
          db,
          screen.elements.map((element) => ({
            tenantId: job.tenantId,
            screenId: id,
            elementKey: element.elementKey,
            fingerprint: element.fingerprint,
            confidence: element.confidence,
            stability: previousKeys.has(element.elementKey) ? 1 : 0,
          })),
        );

        for (const [key, elementId] of ids) elementIdsByKey.set(`${id}:${key}`, elementId);
        return id;
      });

      const durationMs = performance.now() - routeStartedAt;
      deps.metrics.routesTotal.add(1, { outcome: 'indexed' });
      deps.metrics.routeDurationMs.record(durationMs);
      deps.metrics.elementsTotal.add(screen.elements.length);

      await progress.emit({
        kind: 'route_indexed',
        screenId,
        routePattern: screen.routePattern,
        stateFingerprint: screen.stateFingerprint,
        elementCount: screen.elements.length,
        durationMs,
      });

      return screenId;
    },

    async edgeObserved(edge): Promise<void> {
      const triggerElementId = elementIdsByKey.get(
        `${edge.fromScreenId}:${edge.triggerElementKey}`,
      );
      if (triggerElementId === undefined) {
        // The trigger was on a screen this run did not write — a resumed job whose earlier routes
        // are in the database but not in this process's map. The edge is dropped rather than
        // written against a guess.
        return;
      }

      const preconditions: NavPrecondition[] = [
        { kind: 'route_matches', routePattern: edge.fromRoutePattern },
        { kind: 'element_visible', elementKey: edge.triggerElementKey },
      ];

      await deps.database.withTenant(job.tenantId, (db) =>
        upsertNavEdge(db, {
          tenantId: job.tenantId,
          memoryVersionId,
          fromScreenId: edge.fromScreenId,
          toScreenId: edge.toScreenId,
          triggerElementId,
          preconditions,
          confidence: edge.confidence,
        }),
      );

      deps.metrics.edgesTotal.add(1);
      await progress.emit({
        kind: 'edge_recorded',
        fromScreenId: edge.fromScreenId,
        toScreenId: edge.toScreenId,
        triggerElementKey: edge.triggerElementKey,
        confidence: edge.confidence,
      });
    },

    async checkpoint(frontier, visited): Promise<void> {
      await checkpoints.save({ memoryVersionId, frontier: [...frontier], visited: [...visited] });
    },
  };
}
