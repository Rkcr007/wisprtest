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
  PersistenceError,
  SsrfError,
} from './errors.js';
import { consolidate, type EntitySchemaDraft } from './observers/consolidate.js';
import { findDeleteFlows, type DeleteFlowCandidate } from './observers/delete-flow.js';
import { observeForms } from './observers/form-observer.js';
import { createNetworkObserver } from './observers/network-observer.js';
import { persistSchemas } from './observers/repository.js';
import type { ObservedExchange, ObservedForm } from './observers/types.js';
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

    const observedForms: ObservedForm[] = [];
    // Delete controls, gathered as screens are indexed. They come from the crawl rather than from
    // the form or network channels, because a delete flow is an element on a page — see
    // `observers/delete-flow.ts` for why it has to be found now and not at revert time.
    const deleteCandidates: DeleteFlowCandidate[] = [];
    const network = createNetworkObserver({
      allowedOrigins: job.bounds.allowedOrigins,
      onSkipped: (reason: string) => {
        logger.debug({ event: 'network.exchange_skipped', reason }, 'exchange not recorded');
      },
    });

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

      // Attached *after* authentication, and deliberately. A form login posts the tenant's
      // credential for the application under test, and the surest way to guarantee that body is
      // never recorded — not redacted, not templated, never seen — is to not be listening yet.
      network.attach(session.page);

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
          observedForms,
          deleteCandidates,
        }),
      });
    } finally {
      // Bodies still being read have to land before the context goes away, and the context is
      // what is holding them.
      await network.settle();
      await session.close();
    }

    const schemas = await observeSchemas({
      job,
      memoryVersionId: version.id,
      deps,
      forms: observedForms,
      exchanges: network.exchanges(),
      deleteCandidates,
    });

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
        entity_schemas: schemas.length,
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

interface ObserveOptions {
  readonly job: CrawlJob;
  readonly memoryVersionId: string;
  readonly deps: JobRunnerDependencies;
  readonly forms: readonly ObservedForm[];
  readonly exchanges: readonly ObservedExchange[];
  readonly deleteCandidates: readonly DeleteFlowCandidate[];
}

/**
 * Consolidate what the observers saw and write it against the memory version.
 *
 * Runs after the crawl and before activation, so a version never becomes `active` describing
 * screens whose entity schemas were not written. A failure here fails the job: a version that
 * looks complete but has no schemas would have the composer refusing to seed with nothing to say
 * about why, and "the crawl succeeded but the data engine is empty" is not a state an operator
 * should have to diagnose from the outside.
 */
async function observeSchemas(options: ObserveOptions): Promise<readonly EntitySchemaDraft[]> {
  const { job, deps } = options;

  const { schemas, apiCandidates } = consolidate({
    forms: options.forms,
    exchanges: options.exchanges,
    deleteFlows: findDeleteFlows(options.deleteCandidates),
  });

  let counts;
  try {
    counts = await persistSchemas(
      (work) => deps.database.withTenant(job.tenantId, work),
      { tenantId: job.tenantId, memoryVersionId: options.memoryVersionId },
      schemas,
    );
  } catch (error: unknown) {
    throw new PersistenceError(
      `could not write the learned entity schemas: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
      { cause: error },
    );
  }

  for (const schema of schemas) {
    const hasForm = schema.materializers.some((materializer) => materializer.spec.kind === 'ui');
    const channel = schema.observedCount > 0 ? (hasForm ? 'both' : 'network') : 'form';
    deps.metrics.entitySchemasTotal.add(1, { channel });
    for (const materializer of schema.materializers) {
      deps.metrics.materializersTotal.add(1, { kind: materializer.spec.kind });
    }
  }
  deps.metrics.fieldSpecsTotal.add(counts.fields);

  // Entity names and counts only. A field name can be application vocabulary; a distribution or
  // a vocabulary is data, and neither belongs in a log line.
  deps.logger.info(
    {
      event: 'schemas.observed',
      tenant_id: job.tenantId,
      memory_version_id: options.memoryVersionId,
      entities: schemas.map((schema) => ({
        name: schema.entityName,
        fields: schema.fields.length,
        observed: schema.observedCount,
        confidence: schema.confidence,
        materializers: schema.materializers.map((materializer) => materializer.spec.kind),
      })),
      api_candidates: apiCandidates.map((candidate) => ({
        entity: candidate.entityName,
        alignment: candidate.alignment,
      })),
      fields_written: counts.fields,
    },
    'entity schemas consolidated',
  );

  return schemas;
}

interface HandlerOptions {
  readonly job: CrawlJob;
  readonly memoryVersionId: string;
  readonly previousVersionId: string | null;
  readonly deps: JobRunnerDependencies;
  readonly progress: ReturnType<typeof createProgressReporter>;
  readonly checkpoints: ReturnType<typeof createCheckpointStore>;
  /** Filled in as routes are indexed; consolidated once the crawl has finished. */
  readonly observedForms: ObservedForm[];
  readonly deleteCandidates: DeleteFlowCandidate[];
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

      for (const element of screen.elements) {
        options.deleteCandidates.push({
          elementKey: element.elementKey,
          routePattern: screen.routePattern,
          // The redacted name, which is the only form memory holds (CLAUDE.md § "PII rule").
          accessibleNameRedacted: element.fingerprint.accessibleNameRedacted,
          role: element.fingerprint.role,
        });
      }

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

    async formsObserved(observation): Promise<void> {
      // Interpreted immediately but consolidated at the end: a form on one route and the records
      // from an API call on another describe the same entity, and neither is complete until the
      // crawl is. Held in memory rather than written per route for the same reason — an entity
      // schema written from the form alone would be superseded a moment later.
      options.observedForms.push(
        ...observeForms({
          routePattern: observation.routePattern,
          elementKeys: observation.elementKeys,
          regions: observation.regions,
        }),
      );
      await Promise.resolve();
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
