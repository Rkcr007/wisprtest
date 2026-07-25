import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';

import type { GatewayConfig } from '../config.js';
import { currentContext } from '../context/request-context.js';
import { ANONYMOUS_TENANT } from './plugins.js';

/**
 * Per-tenant rate limiting, backed by Redis.
 *
 * Redis rather than in-process counters because the limit has to hold across replicas. An
 * in-memory limiter with four gateway pods gives every tenant four times its budget, and the
 * number silently changes whenever the deployment scales — which makes the limit unusable as a
 * contractual quota and useless as a defence.
 *
 * ## What the key is, and why
 *
 * The tenant, not the IP. A tenant is the unit a quota is sold in and the unit an abusive
 * client is contained by; several testers behind one office NAT would otherwise share a budget,
 * and a single tenant across many machines would evade it entirely.
 *
 * Unauthenticated requests have no tenant, so they fall back to the IP. That is the only sound
 * key available before a token has been verified, and it is what stops an unauthenticated
 * flood from consuming a real tenant's budget — note the rate limiter runs *after*
 * authentication, so by the time a protected route is counted the tenant is known.
 */
export interface RateLimitOptions {
  readonly config: GatewayConfig;
  readonly redis: Redis;
}

export async function registerRateLimit(
  app: FastifyInstance,
  { config, redis }: RateLimitOptions,
): Promise<void> {
  await app.register(rateLimit, {
    // `preHandler`, not the plugin's default `onRequest`. The key is the tenant, and the tenant
    // is not known until the token has been verified — on `onRequest` the key generator sees the
    // anonymous context, falls back to the IP, and every tenant behind one address silently
    // shares a single bucket. Registration order puts this after the authentication hook.
    //
    // The cost is that an unauthenticated flood pays signature verification before being
    // refused. That is the right trade: JWKS is cached, so verification is local CPU, whereas a
    // per-tenant quota that silently degrades to per-IP is not a quota at all.
    hook: 'preHandler',
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    redis,
    // Namespaced separately from application data so a cache flush cannot reset everyone's
    // quota, and so the keys are recognisable when someone is looking at a busy Redis.
    nameSpace: 'ratelimit:',
    keyGenerator: (request) => {
      const tenantId = currentContext()?.tenantId;
      if (tenantId !== undefined && tenantId !== ANONYMOUS_TENANT) return `tenant:${tenantId}`;
      return `ip:${request.ip}`;
    },
    // The probes are polled by the orchestrator on a fixed schedule. Rate limiting them would
    // eventually mark a healthy service dead, which is a self-inflicted outage.
    allowList: (request) => request.url.startsWith('/healthz') || request.url.startsWith('/readyz'),
    // Shape the 429 as a protocol `WisprError` so a client parses one error format, not two.
    errorResponseBuilder: (_request, context) => ({
      code: 'rate_limited',
      message: 'too many requests',
      retryable: true,
      retryAfterSeconds: Math.ceil(context.ttl / 1000),
    }),
    // A Redis outage must not take authentication and readiness down with it. The limiter is a
    // guard rail, not a correctness mechanism, so it fails open and says so loudly.
    onExceeding: () => undefined,
    skipOnError: true,
  });
}
