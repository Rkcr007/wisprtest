import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ExtensionToken, ExtensionTokenRequest } from 'protocol';

import {
  mintExtensionToken,
  originOf,
  scopesForRole,
} from '../auth/extension-token.js';
import type { GatewayConfig } from '../config.js';
import type { TenantDatabase } from '../db/pool.js';
import { GatewayError } from '../errors.js';
import { isRole, type Role } from '../rbac/permissions.js';

/**
 * `POST /v1/auth/extension-token` — mint a scoped token for the page the extension is on.
 *
 * Authenticated by the tester's console session (OIDC bearer), never by an extension token:
 * minting from a minted token would turn one leaked credential into a refresh oracle. The
 * body names an origin, not an application id — resolving that inside the tenant is what
 * stops the extension naming an app it was never granted.
 *
 * An origin that matches no row is still a 200 with `applicationId: null`. That is the
 * "not indexed" attach, not a failure.
 */

export interface ExtensionTokenRoutesOptions {
  readonly config: GatewayConfig;
  readonly database: TenantDatabase;
}

export function registerExtensionTokenRoutes(
  app: FastifyInstance,
  options: ExtensionTokenRoutesOptions,
): void {
  const { config, database } = options;

  app.post(
    '/v1/auth/extension-token',
    { config: { permission: 'session:write' } },
    async (request, reply) => {
      if (request.extension !== undefined) {
        // A minted token asking for another minted token. Refuse: this route is the console
        // session's job, and treating an extension bearer as that session would let a tab
        // refresh itself forever.
        throw new GatewayError('forbidden', 'minting requires a console session', {
          permission: 'session:write',
          requiredRole: 'tester',
        });
      }

      const principal = requirePrincipal(request);
      const parsed = ExtensionTokenRequest.safeParse(request.body);
      if (!parsed.success) {
        throw new GatewayError('validation_failed', 'invalid extension token request', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'root',
            message: issue.message,
          })),
        });
      }

      const origin = originOf(parsed.data.origin);
      if (origin === null) {
        throw new GatewayError('validation_failed', 'origin must be an http(s) URL', {
          issues: [{ path: 'origin', message: 'origin must be an http(s) URL' }],
        });
      }

      const applicationId = await database.withTenant('extension-token-lookup', async (db) => {
        const rows = await db.selectFrom('applications').select(['id', 'baseUrl']).execute();
        const match = rows.find((row) => originOf(row.baseUrl) === origin);
        return match?.id ?? null;
      });

      const minted = await mintExtensionToken(
        {
          email: principal.email,
          userId: principal.userId,
          tenantId: principal.tenantId,
          applicationId,
          scopes: scopesForRole(principal.role),
        },
        config,
      );

      const validated = ExtensionToken.parse(minted);
      return reply.code(200).send(validated);
    },
  );
}

function requirePrincipal(
  request: FastifyRequest,
): { tenantId: string; userId: string; email: string; role: Role } {
  const principal = request.principal;
  if (principal === undefined || !isRole(principal.role)) {
    throw new GatewayError('unauthorized', 'authentication required');
  }
  return principal;
}
