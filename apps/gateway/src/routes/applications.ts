import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpUrl } from 'protocol';
import { z } from 'zod';

import { originOf } from '../auth/extension-token.js';
import type { TenantDatabase } from '../db/pool.js';
import { findActiveMemoryVersion } from '../db/repositories.js';
import { loadEntitySchemas } from '../db/seed-repository.js';
import { GatewayError } from '../errors.js';
import { enrichApplications } from './applications-enrich.js';

export type { ApplicationRecord } from './applications-enrich.js';

/**
 * Register and list applications.
 *
 * Crawl (`POST /v1/applications/:id/crawl`) needs an id that already exists. Until this pair
 * existed the console asked a lead to type a UUID, which is how a fixture id leaked into the
 * Connect form. A lead names a URL; the gateway stores the row; crawl and the extension token
 * mint both resolve from that row.
 *
 * Origin — not the full URL — is what the extension sends on attach. Two applications in one
 * tenant cannot share an origin: the mint would not know which token to issue.
 */

const CreateApplicationBody = z.strictObject({
  name: z.string().trim().min(1).max(200),
  baseUrl: HttpUrl,
  env: z.enum(['development', 'staging', 'production']),
});

const ApplicationIdParams = z.strictObject({
  id: z.uuid(),
});

export interface ApplicationRoutesOptions {
  readonly database: TenantDatabase;
}

export function registerApplicationRoutes(
  app: FastifyInstance,
  options: ApplicationRoutesOptions,
): void {
  const { database } = options;

  function principalOf(request: FastifyRequest): { tenantId: string; userId: string } {
    const principal = request.principal;
    if (principal === undefined) {
      throw new GatewayError('unauthorized', 'authentication required');
    }
    return principal;
  }

  function invalid(message: string, path: string, detail: string): GatewayError {
    return new GatewayError('validation_failed', message, {
      issues: [{ path, message: detail }],
    });
  }

  app.get('/v1/applications', { config: { permission: 'memory:read' } }, async (request) => {
    const { tenantId } = principalOf(request);
    return database.withTenant('list-applications', async (db) => {
      const rows = await db
        .selectFrom('applications')
        .select(['id', 'tenantId', 'name', 'baseUrl', 'env', 'createdAt'])
        .orderBy('name')
        .execute();
      return {
        tenantId,
        applications: await enrichApplications(db, rows),
      };
    });
  });

  app.get<{ Params: { id: string } }>(
    '/v1/applications/:id',
    { config: { permission: 'memory:read' } },
    async (request) => {
      principalOf(request);
      const params = ApplicationIdParams.safeParse(request.params);
      if (!params.success) {
        throw invalid('unknown application', 'id', 'unknown application for this tenant');
      }

      return database.withTenant('get-application', async (db) => {
        const row = await db
          .selectFrom('applications')
          .select(['id', 'tenantId', 'name', 'baseUrl', 'env', 'createdAt'])
          .where('id', '=', params.data.id)
          .executeTakeFirst();
        if (row === undefined) {
          throw invalid('unknown application', 'id', 'unknown application for this tenant');
        }
        const [enriched] = await enrichApplications(db, [row]);
        if (enriched === undefined) {
          throw invalid('unknown application', 'id', 'unknown application for this tenant');
        }
        return enriched;
      });
    },
  );

  /**
   * `POST /v1/applications` — register an application.
   *
   * RBAC: `application:register`, floor `lead`. Same permission as starting a crawl: naming
   * where a headless browser may go is the same class of decision as sending one there.
   */
  app.post('/v1/applications', { config: { permission: 'application:register' } }, async (request, reply) => {
    const { tenantId, userId } = principalOf(request);
    const parsed = CreateApplicationBody.safeParse(request.body);
    if (!parsed.success) {
      throw new GatewayError('validation_failed', 'invalid application', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || 'root',
          message: issue.message,
        })),
      });
    }

    const origin = originOf(parsed.data.baseUrl);
    if (origin === null) {
      throw invalid('baseUrl must be an http(s) URL', 'baseUrl', 'baseUrl must be an http(s) URL');
    }

    const created = await database.withTenant('register-application', async (db) => {
      const existing = await db
        .selectFrom('applications')
        .select(['id', 'name', 'baseUrl'])
        .execute();

      if (existing.some((row) => row.name.toLowerCase() === parsed.data.name.toLowerCase())) {
        throw invalid(
          'an application with this name already exists',
          'name',
          'an application with this name already exists in this tenant',
        );
      }
      if (existing.some((row) => originOf(row.baseUrl) === origin)) {
        throw invalid(
          'an application for this origin already exists',
          'baseUrl',
          'an application for this origin already exists in this tenant',
        );
      }

      const row = await db
        .insertInto('applications')
        .values({
          tenantId,
          name: parsed.data.name,
          baseUrl: parsed.data.baseUrl,
          env: parsed.data.env,
        })
        .returning(['id', 'tenantId', 'name', 'baseUrl', 'env', 'createdAt'])
        .executeTakeFirstOrThrow();

      await db
        .insertInto('auditLog')
        .values({
          tenantId,
          actor: `user:${userId}`,
          action: 'application.registered',
          target: `application:${row.id}`,
          metadata: JSON.stringify({ env: parsed.data.env }),
        })
        .execute();

      return row;
    });

    const [enriched] = await database.withTenant('register-application-enrich', (db) =>
      enrichApplications(db, [created]),
    );
    return reply.code(201).send(enriched);
  });

  /**
   * `GET /v1/applications/:id/schemas` — entity schemas of the active memory version.
   *
   * The Data screen renders what was learned at index time. An application that has never been
   * indexed answers with an empty list and a null version, not a fabricated coverage score.
   */
  app.get<{ Params: { id: string } }>(
    '/v1/applications/:id/schemas',
    { config: { permission: 'memory:read' } },
    async (request) => {
      principalOf(request);
      const params = ApplicationIdParams.safeParse(request.params);
      if (!params.success) {
        throw invalid('unknown application', 'id', 'unknown application for this tenant');
      }

      return database.withTenant('list-application-schemas', async (db) => {
        const application = await db
          .selectFrom('applications')
          .select('id')
          .where('id', '=', params.data.id)
          .executeTakeFirst();
        if (application === undefined) {
          throw invalid('unknown application', 'id', 'unknown application for this tenant');
        }

        const active = await findActiveMemoryVersion(db, params.data.id);
        if (active === undefined) {
          return { applicationId: params.data.id, memoryVersionId: null, schemas: [] };
        }

        const loaded = await loadEntitySchemas(db, active.id);
        return {
          applicationId: params.data.id,
          memoryVersionId: active.id,
          schemas: loaded.schemas,
        };
      });
    },
  );
}
