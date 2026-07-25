import { randomUUID } from 'node:crypto';

import { trace } from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';

import { createJwks, type Jwks } from '../auth/jwks.js';
import { readBearerToken, verifyToken } from '../auth/verify.js';
import type { GatewayConfig } from '../config.js';
import {
  attachPrincipal,
  runWithContext,
  type RequestContext,
} from '../context/request-context.js';
import type { TenantDatabase } from '../db/pool.js';
import { findPrincipalByEmail } from '../db/repositories.js';
import { UnauthorizedError } from '../errors.js';
import { assertPermission, isRole, type Permission, type Role } from '../rbac/permissions.js';

/**
 * The request pipeline: context, then authentication, then authorisation.
 *
 * Order matters, and Fastify's hook ordering enforces it rather than a convention:
 *
 * 1. **`onRequest`** establishes the ambient context for the whole request, anonymous to begin
 *    with. It runs for unauthenticated routes too, so a `/healthz` line still carries a request
 *    id and a trace id.
 * 2. **`preHandler`** authenticates when the route asks for it, and swaps in a context carrying
 *    the tenant. That swap is what makes the database reachable at all: `withTenant` refuses
 *    without a tenant, so an unauthenticated code path cannot query even by mistake.
 * 3. **The same hook** then authorises against the route's declared permission.
 *
 * Authentication is opt-*out*. A route must say `config: { public: true }` to skip it, so a new
 * route added without thinking about auth is protected rather than exposed — the failure mode
 * of an opt-in scheme is a public endpoint nobody noticed.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication hook. Absent on public routes. */
    principal?: { userId: string; tenantId: string; role: Role; email: string };
  }
  interface FastifyContextConfig {
    /** Opt out of authentication. Default is to require it. */
    public?: boolean;
    /** Permission this route requires, checked after authentication. */
    permission?: Permission;
  }
}

/**
 * The tenant an unauthenticated request runs as.
 *
 * A real UUID rather than null, because `RequestContext.tenantId` is non-optional: no code path
 * can read the field, find nothing, and carry on with an unscoped query. It matches no row in
 * any table, so a query that somehow ran under it returns nothing rather than someone's data.
 */
export const ANONYMOUS_TENANT = '00000000-0000-0000-0000-000000000000';

export interface PipelineOptions {
  readonly config: GatewayConfig;
  readonly database: TenantDatabase;
  /** Injected so tests supply a key set directly. Built from config, with discovery, otherwise. */
  readonly jwks?: Jwks;
}

export function registerPipeline(app: FastifyInstance, options: PipelineOptions): void {
  const { config, database } = options;
  const jwks = options.jwks ?? createJwks(config);

  // Synchronous, and `done()` is called *inside* the store: AsyncLocalStorage propagates into
  // the async subtree of the call that created it, so invoking Fastify's continuation from
  // within `run` is what puts every later hook, the handler, and every log line inside it.
  app.addHook('onRequest', (request, reply, done) => {
    const span = trace.getActiveSpan();
    const context: RequestContext = {
      tenantId: ANONYMOUS_TENANT,
      userId: null,
      role: null,
      sessionId: null,
      // Falls back to a generated id so a log line is correlatable even with tracing disabled.
      traceId: span?.spanContext().traceId ?? randomUUID().replace(/-/g, ''),
      requestId: request.id,
    };

    runWithContext(context, () => {
      reply.header('x-request-id', request.id);
      done();
    });
  });

  app.addHook('preHandler', async (request) => {
    if (request.routeOptions.config.public === true) return;

    const token = readBearerToken(request.headers.authorization);
    const verified = await verifyToken(token, jwks, config);

    const principal = await findPrincipalByEmail(database, verified.email);
    if (principal === null) {
      // The token is genuine but names somebody no tenant knows. Unauthenticated rather than
      // forbidden — there is no principal to authorise in the first place.
      throw new UnauthorizedError('token subject does not resolve to a known user');
    }

    if (!isRole(principal.role)) {
      // The database CHECK makes this unreachable today, and it is still checked: a role the
      // permission map does not know must never be treated as "some role" and waved through.
      throw new UnauthorizedError(`user holds an unrecognised role: ${principal.role}`);
    }

    request.principal = { ...principal, role: principal.role };

    // Fills in the context the `onRequest` hook created. Not a second `runWithContext`: a
    // context established inside a hook is gone by the time the handler runs, and the request
    // would authenticate successfully and then query as nobody.
    attachPrincipal({
      tenantId: principal.tenantId,
      userId: principal.userId,
      role: principal.role,
      sessionId: verified.sessionId,
    });

    const permission = request.routeOptions.config.permission;
    if (permission !== undefined) assertPermission(principal.role, permission);
  });
}
