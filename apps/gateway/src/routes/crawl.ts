import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

import { context, propagation, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { AuthProfile, CrawlBounds, type CrawlJob, type IndexProgressEvent } from 'protocol';
import { z } from 'zod';

import type { GatewayConfig } from '../config.js';
import type { ScopedDatabase, TenantDatabase } from '../db/pool.js';
import { GatewayError } from '../errors.js';
import {
  enqueueCrawlJob,
  findLatestJobId,
  readProgressStream,
  type ProgressDelivery,
} from '../redis/crawl-queue.js';
import { METER_NAME, type GatewayMetrics } from '../telemetry/metrics.js';

/**
 * `/v1/applications/:id/crawl` and `/v1/applications/:id/index-progress` — starting an index, and
 * watching one.
 *
 * Until now the only way to index an application was to write a `CrawlJob` onto a Redis stream by
 * hand, and the only way to watch one was to tail Redis. These two routes are what make the
 * indexer reachable from the console: one enqueues, the other streams what comes back.
 *
 * ## The gateway does not decide what a crawl may do — but it does refuse an unbounded one
 *
 * docs/ARCHITECTURE.md § 5 is explicit that the gateway "never contains business logic for
 * composition or crawling — it orchestrates". So bounds and the auth profile arrive on the
 * request, travel on the job, and are executed by the worker: the record of what a crawl was
 * permitted to do is the same record that ran.
 *
 * What the gateway *does* enforce is that the bounds exist and contain the crawl. Phase 5:
 * "These bounds are config, and the crawl must refuse to start without them." `CrawlBounds` makes
 * every one of them a required field, so a request missing the route allowlist, the depth cap, the
 * page cap or the never-interact list fails validation here and is answered with a typed
 * `validation_failed` naming the field — long before a browser exists.
 *
 * ## Why `baseUrl` is read from the application, not from the request
 *
 * A crawl starts where the application lives, and that is registered per-application
 * configuration. Accepting a start URL on the request would let an authenticated caller aim a
 * headless browser — inside our network, holding the tenant's session — at any address they like,
 * with only the allowlist they supplied in the same request standing in the way. Reading it from
 * the applications row removes the choice, and the origin check below makes the allowlist prove it
 * covers that origin rather than the other way round.
 *
 * ## Progress is per job; the console follows an application
 *
 * The indexer publishes to one stream per job (`apps/indexer/src/redis/progress.ts`). The console
 * has an application id and wants "what is happening to this app right now", so the enqueue writes
 * a tenant-scoped pointer from application to its latest job and the progress route follows it. A
 * caller that holds a specific job id — the one the enqueue returned — can name it instead and get
 * that job's stream, including after another has started.
 */

export interface CrawlRoutesOptions {
  readonly config: GatewayConfig;
  readonly database: TenantDatabase;
  readonly redis: Redis;
  readonly metrics: GatewayMetrics;
}

/**
 * The request body.
 *
 * Composed from the contract's own `CrawlBounds` and `AuthProfile` rather than restating them:
 * these are the shapes that travel to the indexer, and a second definition of either here is a
 * second thing to keep in step. Strict, so a misspelled key is a 400 rather than a bound silently
 * left at whatever the schema requires.
 */
const CrawlRequestBody = z.strictObject({
  bounds: CrawlBounds,
  authProfile: AuthProfile,
});

/** Query parameters of the progress stream. */
const ProgressQuery = z.strictObject({
  /** A specific job. Absent means "whatever is current for this application". */
  jobId: z.uuid().optional(),
});

/**
 * How long one `XREAD` blocks before the stream emits a keep-alive.
 *
 * Under the 30–60 s idle timeout typical of proxies and load balancers, so a crawl that spends a
 * minute on a slow route does not look to the intermediary like a dead connection.
 */
const PROGRESS_BLOCK_MS = 15_000;

/** Reconnect delay suggested to `EventSource` clients, in milliseconds. */
const SSE_RETRY_MS = 3_000;

/** The events after which there is nothing more to send for a job. */
const TERMINAL_KINDS = new Set(['job_completed', 'job_failed']);

export function registerCrawlRoutes(app: FastifyInstance, options: CrawlRoutesOptions): void {
  const { config, database, redis, metrics } = options;
  const tracer = trace.getTracer(METER_NAME);

  /** The authenticated principal, or a typed 401. */
  function principalOf(request: FastifyRequest): { tenantId: string; userId: string } {
    const principal = request.principal;
    if (principal === undefined) {
      // Unreachable: both routes require authentication. Checked rather than asserted, because a
      // crawl enqueued without a tenant is a crawl of somebody else's application.
      throw new GatewayError('unauthorized', 'authentication required');
    }
    return principal;
  }

  function invalid(message: string, path: string, detail: string): GatewayError {
    return new GatewayError('validation_failed', message, {
      issues: [{ path, message: detail }],
    });
  }

  /**
   * The application, or a typed 422-shaped refusal.
   *
   * Row-level security makes another tenant's application invisible, so a cross-tenant id reads
   * as absent and is answered exactly as an unknown id is — the caller learns nothing about
   * whether the id exists elsewhere.
   */
  async function requireApplication(
    db: ScopedDatabase,
    applicationId: string,
  ): Promise<{ id: string; baseUrl: string }> {
    const application = await db
      .selectFrom('applications')
      .select(['id', 'baseUrl'])
      .where('id', '=', applicationId)
      .executeTakeFirst();

    if (application === undefined) {
      throw invalid('unknown application', 'id', 'unknown application for this tenant');
    }
    return application;
  }

  /**
   * `POST /v1/applications/:id/crawl` — enqueue a crawl.
   *
   * ## RBAC: `application:register`, which floors at `lead`
   *
   * The declarative map in `src/rbac/permissions.ts` names `application:register` as gating
   * "registering an app and starting an index", for Phase 5 — this route. Its least privileged
   * holder is `lead`, and that is the right floor for three reasons. A crawl drives a real browser
   * against the customer's application under a real login, so it is a load a tester should not be
   * able to start unsupervised. It consumes the auth profile, which points at the tenant's
   * credentials. And it produces a new memory version, which `memory:approve` — also lead and
   * above — is what activates; a tester able to start indexing but not to approve the result would
   * be able to queue work nobody downstream had agreed to.
   *
   * Nothing here re-checks the role: `assertPermission` runs in the pipeline's `preHandler` from
   * the `config.permission` below, so the policy stays in one reviewable table.
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/applications/:id/crawl',
    { config: { permission: 'application:register' } },
    async (request, reply) => {
      const { tenantId, userId } = principalOf(request);
      const applicationId = request.params.id;

      return tracer.startActiveSpan('crawl.enqueue', async (span: Span) => {
        // ARCHITECTURE § 7 names `tenant_id` and `app_id` as span attributes. Ids only — nothing
        // here carries a URL or a name belonging to the application under test.
        span.setAttribute('tenant_id', tenantId);
        span.setAttribute('app_id', applicationId);

        try {
          const parsed = CrawlRequestBody.safeParse(request.body);
          if (!parsed.success) {
            // The refusal Phase 5 asks for. A body without `bounds`, or with bounds missing the
            // route allowlist, depth cap, page cap or never-interact list, lands here and names
            // the offending path — a browser is never launched.
            throw new GatewayError('validation_failed', 'invalid crawl request', {
              issues: parsed.error.issues.map((issue) => ({
                path: issue.path.join('.') || 'root',
                message: issue.message,
              })),
            });
          }

          const jobId = randomUUID();
          const requestedAt = new Date().toISOString();
          span.setAttribute('job_id', jobId);

          const enqueued = await database.withTenant('crawl-enqueue', async (db) => {
            const application = await requireApplication(db, applicationId);

            if (!originIsAllowed(application.baseUrl, parsed.data.bounds.allowedOrigins)) {
              // The allowlist has to cover the place the crawl starts, or the very first
              // navigation is off-allowlist and the job can only fail — after paying for a
              // browser, a login and a worker slot.
              throw invalid(
                'the crawl bounds do not allow the application’s own origin',
                'bounds.allowedOrigins',
                'allowedOrigins must include the origin the application is registered at',
              );
            }

            const job: CrawlJob = {
              jobId,
              tenantId,
              applicationId: application.id,
              baseUrl: application.baseUrl,
              bounds: parsed.data.bounds,
              authProfile: parsed.data.authProfile,
              requestedBy: userId,
              requestedAt,
              // Joins the crawl's spans to the console's trace instead of starting a
              // disconnected one. Null when nothing is tracing, which is the local default.
              traceparent: currentTraceparent(),
            };

            // ARCHITECTURE § 8 requires every memory mutation to be audited, and a crawl is the
            // largest one the system performs. Written inside the transaction that enqueues, so
            // a Redis failure rolls the record back rather than leaving an audit entry for a
            // crawl that never started.
            await db
              .insertInto('auditLog')
              .values({
                tenantId,
                actor: `user:${userId}`,
                action: 'application.crawl_enqueued',
                target: `application:${application.id}`,
                // Structure only. The auth profile is recorded by *kind*: its secret reference
                // names where a credential lives, and that does not belong in an audit row.
                metadata: JSON.stringify({
                  jobId,
                  authProfileKind: parsed.data.authProfile.kind,
                  maxDepth: parsed.data.bounds.maxDepth,
                  maxPages: parsed.data.bounds.maxPages,
                  requestsPerMinute: parsed.data.bounds.requestsPerMinute,
                  routeAllowlist: parsed.data.bounds.routeAllowlist,
                  allowedOrigins: parsed.data.bounds.allowedOrigins,
                  neverInteractSelectorCount: parsed.data.bounds.neverInteractSelectors.length,
                }),
              })
              .execute();

            return enqueueCrawlJob(redis, config.INDEXER_JOB_STREAM, job);
          });

          metrics.indexJobsEnqueuedTotal.add(1, { outcome: 'enqueued' });
          request.log.info(
            {
              event: 'index.job.enqueued',
              job_id: jobId,
              app_id: applicationId,
              message_id: enqueued.messageId,
              max_depth: parsed.data.bounds.maxDepth,
              max_pages: parsed.data.bounds.maxPages,
              auth_profile_kind: parsed.data.authProfile.kind,
            },
            'crawl job enqueued',
          );

          span.setStatus({ code: SpanStatusCode.OK });

          // 202: the work is accepted, not done. The body is the job's identity plus the URL that
          // follows it, so a caller needs no knowledge of how progress is addressed.
          return await reply
            .code(202)
            .header('cache-control', 'private, no-store')
            .header('location', progressPath(applicationId, jobId))
            .send({
              jobId,
              applicationId,
              messageId: enqueued.messageId,
              requestedAt,
              progressUrl: progressPath(applicationId, jobId),
            });
        } catch (error: unknown) {
          const outcome = error instanceof GatewayError ? error.code : 'internal';
          metrics.indexJobsEnqueuedTotal.add(1, { outcome: 'rejected' });
          span.setStatus({ code: SpanStatusCode.ERROR, message: outcome });
          // Re-thrown to the single error handler, which owns the status mapping and the log line.
          throw error;
        } finally {
          span.end();
        }
      });
    },
  );

  /**
   * `GET /v1/applications/:id/index-progress` — Server-Sent Events for one crawl.
   *
   * SSE rather than a WebSocket: the traffic is one-directional, it has to survive a proxy that
   * only understands HTTP, and `EventSource` reconnects on its own. Reconnection is why every
   * frame carries the Redis stream id as its SSE `id` — the browser replays it as `Last-Event-ID`
   * and the read resumes from exactly there, so a dropped connection costs no events.
   *
   * `memory:read` is the floor: this is a read of the tenant's own indexing state, the same
   * privilege that reads memory itself, and a viewer watching a crawl can change nothing by it.
   */
  app.get<{ Params: { id: string }; Querystring: unknown }>(
    '/v1/applications/:id/index-progress',
    { config: { permission: 'memory:read' } },
    async (request, reply) => {
      const { tenantId } = principalOf(request);
      const applicationId = request.params.id;

      const query = ProgressQuery.safeParse(request.query);
      if (!query.success) {
        throw new GatewayError('validation_failed', 'invalid progress request', {
          issues: query.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'root',
            message: issue.message,
          })),
        });
      }

      // Everything that can fail is resolved *before* the reply is hijacked: once the socket is
      // taken over, the single error handler can no longer answer, and a caller would get an
      // empty 200 where they should have got a typed refusal.
      await database.withTenant('crawl-progress', (db) => requireApplication(db, applicationId));

      const jobId =
        query.data.jobId ?? (await findLatestJobId(redis, tenantId, applicationId)) ?? null;
      if (jobId === null) {
        throw invalid(
          'no index job to follow for this application',
          'jobId',
          'this application has no recent index job; start one with POST /v1/applications/:id/crawl',
        );
      }

      await streamProgress(request, reply, { tenantId, applicationId, jobId });
    },
  );

  interface StreamTarget {
    readonly tenantId: string;
    readonly applicationId: string;
    readonly jobId: string;
  }

  /** Take over the socket and pump the job's progress stream onto it until either end stops. */
  async function streamProgress(
    request: FastifyRequest,
    reply: FastifyReply,
    target: StreamTarget,
  ): Promise<void> {
    const { tenantId, applicationId, jobId } = target;
    const startedAt = performance.now();

    const controller = new AbortController();
    const stop = (): void => {
      controller.abort();
    };

    reply.hijack();
    const socket = reply.raw;

    // Aborted when the client goes away. The reader disconnects its Redis connection on it, which
    // is what stops a closed tab leaving a socket parked in a fifteen-second blocking read.
    //
    // Listened for on the *response*, not the request: since Node 16 an `IncomingMessage` emits
    // `close` as soon as the request itself is complete, which for a bodiless GET is immediately —
    // it would abort the stream before a single event was sent. `ServerResponse` emits `close`
    // when the response finishes or the connection is torn down early, which is the question
    // actually being asked.
    socket.on('close', stop);
    socket.on('error', stop);
    socket.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      // A progress stream is a tenant's indexing state; no shared cache may hold it, and an
      // intermediary that buffers it defeats the point of streaming at all.
      'cache-control': 'private, no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': request.id,
    });
    socket.flushHeaders();

    metrics.indexProgressSubscribers.add(1, { app_id: applicationId });
    request.log.info(
      { event: 'index.progress.opened', job_id: jobId, app_id: applicationId },
      'index progress stream opened',
    );

    let forwarded = 0;
    let closedReason = 'client_disconnected';

    try {
      await write(socket, `retry: ${String(SSE_RETRY_MS)}\n\n`);

      for await (const delivery of readProgressStream(redis, {
        tenantId,
        jobId,
        fromId: resumePoint(request),
        blockMs: PROGRESS_BLOCK_MS,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) break;

        if (delivery.kind === 'idle') {
          // An SSE comment. Keeps the connection alive through an idle proxy without the client
          // having to know about a heartbeat event it would otherwise have to ignore.
          await write(socket, ': keep-alive\n\n');
          continue;
        }

        if (delivery.kind === 'malformed') {
          // Never forwarded: the console parses these with the contract, and an event that fails
          // there is a bug on the writing side. Reported so it is findable, and skipped.
          metrics.indexProgressEventsTotal.add(1, { kind: 'malformed' });
          request.log.warn(
            {
              event: 'index.progress.malformed',
              job_id: jobId,
              message_id: delivery.messageId,
              issues: delivery.issues,
            },
            'discarded an unparseable progress event',
          );
          continue;
        }

        await write(socket, frame(delivery));
        forwarded += 1;
        metrics.indexProgressEventsTotal.add(1, { kind: delivery.event.kind });

        if (TERMINAL_KINDS.has(delivery.event.kind)) {
          // The crawl is over, so there is nothing further to wait for. A named `end` frame is
          // sent first, because `EventSource` reconnects on a bare close and would otherwise
          // reopen the stream to sit on a finished job.
          await write(socket, `event: end\ndata: ${JSON.stringify({ jobId })}\n\n`);
          closedReason = delivery.event.kind;
          break;
        }
      }
    } catch (error: unknown) {
      closedReason = 'stream_failed';
      request.log.error(
        { event: 'index.progress.failed', job_id: jobId, err: error },
        'index progress stream failed',
      );
      // The headers are long gone, so a status code is not available to say this. A named frame
      // is, and the console can tell a failed stream from a finished one.
      if (socket.writable) {
        await write(socket, `event: error\ndata: ${JSON.stringify({ jobId })}\n\n`);
      }
    } finally {
      socket.removeListener('close', stop);
      socket.removeListener('error', stop);
      controller.abort();
      metrics.indexProgressSubscribers.add(-1, { app_id: applicationId });
      if (socket.writable) socket.end();

      request.log.info(
        {
          event: 'index.progress.closed',
          job_id: jobId,
          app_id: applicationId,
          reason: closedReason,
          events: forwarded,
          duration_ms: Math.round(performance.now() - startedAt),
        },
        'index progress stream closed',
      );
    }
  }
}

/** One SSE frame. The stream id is the event id, which is what makes `Last-Event-ID` work. */
function frame(delivery: Extract<ProgressDelivery, { kind: 'event' }>): string {
  const event: IndexProgressEvent = delivery.event;
  return `id: ${delivery.messageId}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Where to resume from.
 *
 * `Last-Event-ID` is set by `EventSource` on reconnect and holds the last stream id it saw, so the
 * read continues after it. Absent — a first connection — starts at `0`, replaying everything the
 * job's stream still retains, which is what makes a console tab opened halfway through a crawl
 * show the routes already indexed rather than starting blank.
 */
function resumePoint(request: FastifyRequest): string {
  const header = request.headers['last-event-id'];
  const value = Array.isArray(header) ? header[0] : header;
  // Redis stream ids are `<millis>-<seq>`. Anything else is not one, and passing it on would make
  // `XREAD` fail the whole stream rather than start it.
  return typeof value === 'string' && /^\d+-\d+$/.test(value) ? value : '0';
}

/** `/v1/applications/:id/index-progress?jobId=…` — the URL that follows a job. */
function progressPath(applicationId: string, jobId: string): string {
  return `/v1/applications/${applicationId}/index-progress?jobId=${jobId}`;
}

/**
 * Write one chunk, respecting backpressure.
 *
 * A console that has stopped reading — a backgrounded tab, a stalled link — must not make the
 * gateway buffer a whole crawl's events in memory. Waiting for `drain` propagates the stall back
 * into the read loop, which simply stops consuming from Redis until the client catches up.
 *
 * `close` resolves the wait as well as `drain`, because a connection that went away will never
 * drain: without it a disconnected client would leave this promise pending forever, holding the
 * Redis connection the reader's `finally` is waiting to close. The loop's abort check is what
 * notices and exits.
 */
function write(socket: ServerResponse, chunk: string): Promise<void> {
  if (socket.write(chunk)) return Promise.resolve();

  return new Promise<void>((resolve) => {
    function done(): void {
      socket.removeListener('drain', done);
      socket.removeListener('close', done);
      resolve();
    }
    socket.once('drain', done);
    socket.once('close', done);
  });
}

/** True when `baseUrl`'s origin is one of the allowed origins. Compared as origins, not strings. */
function originIsAllowed(baseUrl: string, allowedOrigins: readonly string[]): boolean {
  const origin = originOf(baseUrl);
  if (origin === null) return false;
  return allowedOrigins.some((allowed) => originOf(allowed) === origin);
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    // Both sides are `HttpUrl` by the time they reach here — the column is written by application
    // registration and the allowlist is contract-validated — so this is unreachable, and it
    // returns null rather than throwing because a malformed URL must read as "not allowed".
    return null;
  }
}

/**
 * The W3C `traceparent` of this request, or null when nothing is tracing.
 *
 * Taken from the configured propagator rather than assembled by hand from the span context, so
 * the header is whatever the deployment's trace-context format actually is. Null locally, where
 * no exporter is configured and there is no sampled span to propagate — which is why the contract
 * makes the field nullable rather than optional.
 */
function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const value = carrier.traceparent;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
