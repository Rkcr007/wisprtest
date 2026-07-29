import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { Jwks } from '../auth/jwks.js';
import type { GatewayConfig } from '../config.js';
import { currentContext } from '../context/request-context.js';
import type { TenantDatabase } from '../db/pool.js';
import { asWisprError, GatewayError, httpStatusFor, toWisprError } from '../errors.js';
import { createAnthropicProvider, type ModelProvider } from '../model/index.js';
import type { GatewayMetrics } from '../telemetry/metrics.js';
import { registerMemoryRoutes } from '../routes/memory.js';
import { registerResolveRoutes } from '../routes/resolve.js';
import { registerHealth } from './health.js';
import { registerPipeline } from './plugins.js';
import { registerRateLimit } from './rate-limit.js';

/**
 * Assembles the HTTP server.
 *
 * Separate from `main.ts` so the integration tests build a real server — same plugins, same
 * hooks, same error handler — against the real compose stack, without starting a process or
 * binding a port. What the tests exercise is what runs in production; the only difference is
 * `app.inject` in place of a socket.
 *
 * Registration order is load-bearing: the pipeline installs the request context before anything
 * else, so the rate limiter's key generator and every log line can see it.
 */
export interface ServerOptions {
  readonly config: GatewayConfig;
  readonly logger: Logger;
  readonly database: TenantDatabase;
  readonly redis: Redis;
  readonly metrics: GatewayMetrics;
  /** Supplied by tests to skip OIDC discovery; built from config otherwise. */
  readonly jwks?: Jwks;
  /**
   * The T2 escalation model. Built from config as the real Anthropic provider when absent; a test
   * injects a fake so `test:resolve` needs neither a key nor the network. Constructing the real
   * one here makes no call — it only closes over the key and base URL until the route is hit.
   */
  readonly modelProvider?: ModelProvider;
}

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const { config, logger, metrics } = options;

  // Passing a concrete pino `Logger` makes Fastify infer an instance type parameterised by it,
  // which then does not match the plain `FastifyInstance` the plugin helpers accept. The two are
  // structurally the same server — pino's logger satisfies `FastifyBaseLogger` in full — so the
  // instance is widened once, here, rather than every helper being made generic over a logger
  // type none of them care about.
  const app = Fastify({
    loggerInstance: logger,
    // Fastify's own per-request lines would duplicate what the `onResponse` hook below records,
    // and they are emitted before the context hook has run, so they would be the only lines in
    // the system without a tenant id on them.
    logController: new LogController({ disableRequestLogging: true }),
    // Trust the id from an upstream proxy when it supplies one, so a trace spans the edge.
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    // A body larger than this is a bug or an attack; the largest legitimate payload is a
    // batched step ingest, which Phase 12 sizes.
    bodyLimit: 1_048_576,
  }) as unknown as FastifyInstance;

  registerPipeline(app, {
    config,
    database: options.database,
    ...(options.jwks === undefined ? {} : { jwks: options.jwks }),
  });
  await registerRateLimit(app, { config, redis: options.redis });
  registerHealth(app, { config, database: options.database, redis: options.redis });
  registerMemoryRoutes(app, {
    config,
    database: options.database,
    redis: options.redis,
    metrics,
  });
  registerResolveRoutes(app, {
    config,
    metrics,
    modelProvider:
      options.modelProvider ??
      createAnthropicProvider({ apiKey: config.MODEL_API_KEY, baseUrl: config.MODEL_BASE_URL }),
  });

  app.addHook('onResponse', (request, reply, done) => {
    const attributes = {
      method: request.method,
      // The route pattern, never the resolved URL: `/v1/orders/:id` is a bounded label set,
      // whereas the raw path would mint a new metric series per order id.
      route: request.routeOptions.url ?? 'unmatched',
      status_class: `${String(Math.floor(reply.statusCode / 100))}xx`,
    };

    metrics.httpRequestsTotal.add(1, attributes);
    metrics.httpRequestDurationMs.record(reply.elapsedTime, attributes);

    // One line per request, carrying the correlation fields from the ambient context. The URL
    // is logged, the query string is not: a query string can carry an identifier that is
    // customer data.
    request.log.info(
      {
        event: 'http.request',
        method: request.method,
        route: attributes.route,
        status: reply.statusCode,
        duration_ms: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
    done();
  });

  /**
   * The single error handler.
   *
   * Every failure leaves through here, so the status mapping lives in exactly one table and a
   * response body is always a protocol `WisprError` — a client parses one shape whatever went
   * wrong. Fastify's own validation errors are translated too, rather than being allowed out in
   * their native format.
   */
  app.setErrorHandler((error, request, reply) => {
    const traceId = currentContext()?.traceId ?? request.id;
    const status = statusFor(error);
    const body = toWisprError(error, traceId);

    // Client mistakes are noise at error level; genuine failures are not. Logging a 401 as an
    // error trains people to ignore the error log, which is where the 500s are.
    const level = status >= 500 ? 'error' : 'warn';
    request.log[level](
      {
        event: 'http.error',
        code: body.code,
        status,
        // The internal reason, which the response body deliberately withholds.
        detail: error instanceof GatewayError ? error.details : undefined,
        err: error,
      },
      'request failed',
    );

    if (status === 429 && 'retryAfterSeconds' in body) {
      reply.header('retry-after', String(body.retryAfterSeconds));
    }

    reply.code(status).send(body);
  });

  /**
   * Unmatched routes.
   *
   * The application-level authentication hook runs before this, so an *unauthenticated* probe
   * gets 401 for every path whether it exists or not — it learns nothing about the shape of the
   * API by enumerating. An authenticated caller gets a plain 404, which is what they need.
   */
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      code: 'resolution_not_found',
      message: `no route for ${request.method} ${request.url}`,
      retryable: false,
      targetPhrase: '',
      tier: 'T0',
    });
  });

  return app;
}

interface StatusCarrier {
  readonly statusCode?: unknown;
}

function statusFor(error: unknown): number {
  if (error instanceof GatewayError) return httpStatusFor(error.code);

  // A plugin that threw a payload already shaped as a protocol error — the rate limiter does
  // exactly this — is mapped by the same table as everything else, so there is still only one
  // place a code becomes a status.
  const protocolError = asWisprError(error);
  if (protocolError !== null) return httpStatusFor(protocolError.code);

  // Fastify's own validation errors carry their status.
  const statusCode = (error as StatusCarrier).statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599) return statusCode;

  return 500;
}
