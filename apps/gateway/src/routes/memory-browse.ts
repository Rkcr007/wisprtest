import type { FastifyInstance } from 'fastify';
import {
  Alias,
  ElementRecord,
  NavEdge,
  ScreenNode,
  type Alias as AliasRecord,
  type ElementRecord as ElementRow,
  type NavEdge as NavEdgeRecord,
  type ScreenNode as ScreenRow,
} from 'protocol';
import { z } from 'zod';

import { assertApplicationScope } from '../auth/extension-token.js';
import type { TenantDatabase } from '../db/pool.js';
import { findActiveMemoryVersion } from '../db/repositories.js';
import { GatewayError } from '../errors.js';
import { parsePage } from '../http/page.js';

/**
 * Browse the active memory version one page at a time.
 *
 * The snapshot route is the extension's boot payload. These routes are the console's explorer:
 * screens, elements, the navigation graph, and the alias corpus. They never invent coverage and
 * they never return raw element text — fingerprints already carry redacted names only.
 *
 * An application with no active version is an empty explorer, not an error. That is the honest
 * answer for a URL that was registered and has not been indexed yet.
 */

const AppParams = z.strictObject({
  appId: z.uuid(),
});

const ElementQuery = z.object({
  screenId: z.uuid().optional(),
});

export interface MemoryBrowseRoutesOptions {
  readonly database: TenantDatabase;
}

export function registerMemoryBrowseRoutes(
  app: FastifyInstance,
  options: MemoryBrowseRoutesOptions,
): void {
  const { database } = options;

  function principalOf(request: { principal?: { tenantId: string } }): { tenantId: string } {
    const principal = request.principal;
    if (principal === undefined) {
      throw new GatewayError('unauthorized', 'authentication required');
    }
    return principal;
  }

  function invalid(message: string, path: string, detail: string): GatewayError {
    return new GatewayError('validation_failed', message, { issues: [{ path, message: detail }] });
  }

  function parseAppId(params: unknown): string {
    const parsed = AppParams.safeParse(params);
    if (!parsed.success) {
      throw invalid('unknown application', 'appId', 'unknown application for this tenant');
    }
    return parsed.data.appId;
  }

  app.get<{ Params: { appId: string } }>(
    '/v1/memory/:appId/screens',
    { config: { permission: 'memory:read' } },
    async (request) => {
      principalOf(request);
      const appId = parseAppId(request.params);
      assertApplicationScope(request.extension?.applicationId, appId);
      const page = parsePage(request.query);

      return database.withTenant('memory-browse-screens', async (db) => {
        const version = await requireActiveOrEmpty(db, appId);
        if (version === null) {
          return { applicationId: appId, memoryVersionId: null, screens: [], total: 0 };
        }

        const [rows, totalRow] = await Promise.all([
          db
            .selectFrom('screens')
            .select([
              'id',
              'memoryVersionId',
              'routePattern',
              'stateFingerprint',
              'label',
              'structuralHash',
              'indexedAt',
            ])
            .where('memoryVersionId', '=', version.id)
            .orderBy('routePattern')
            .orderBy('id')
            .limit(page.limit)
            .offset(page.offset)
            .execute(),
          db
            .selectFrom('screens')
            .select((eb) => eb.fn.countAll<string>().as('total'))
            .where('memoryVersionId', '=', version.id)
            .executeTakeFirst(),
        ]);

        return {
          applicationId: appId,
          memoryVersionId: version.id,
          screens: rows.map(toScreen),
          total: Number(totalRow?.total ?? 0),
        };
      });
    },
  );

  app.get<{ Params: { appId: string } }>(
    '/v1/memory/:appId/elements',
    { config: { permission: 'memory:read' } },
    async (request) => {
      principalOf(request);
      const appId = parseAppId(request.params);
      assertApplicationScope(request.extension?.applicationId, appId);
      const page = parsePage(request.query);
      const filter = ElementQuery.safeParse(request.query);
      if (!filter.success) {
        throw new GatewayError('validation_failed', 'invalid element query', {
          issues: filter.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'root',
            message: issue.message,
          })),
        });
      }

      return database.withTenant('memory-browse-elements', async (db) => {
        const version = await requireActiveOrEmpty(db, appId);
        if (version === null) {
          return { applicationId: appId, memoryVersionId: null, elements: [], total: 0 };
        }

        if (filter.data.screenId !== undefined) {
          const screen = await db
            .selectFrom('screens')
            .select('id')
            .where('id', '=', filter.data.screenId)
            .where('memoryVersionId', '=', version.id)
            .executeTakeFirst();
          if (screen === undefined) {
            throw invalid('unknown screen', 'screenId', 'unknown screen for this memory version');
          }
        }

        let listed = db
          .selectFrom('elements')
          .innerJoin('screens', 'screens.id', 'elements.screenId')
          .select([
            'elements.id as id',
            'elements.screenId as screenId',
            'elements.elementKey as elementKey',
            'elements.fingerprint as fingerprint',
            'elements.confidence as confidence',
            'elements.stability as stability',
          ])
          .where('screens.memoryVersionId', '=', version.id);
        let counted = db
          .selectFrom('elements')
          .innerJoin('screens', 'screens.id', 'elements.screenId')
          .select((eb) => eb.fn.countAll<string>().as('total'))
          .where('screens.memoryVersionId', '=', version.id);

        if (filter.data.screenId !== undefined) {
          listed = listed.where('elements.screenId', '=', filter.data.screenId);
          counted = counted.where('elements.screenId', '=', filter.data.screenId);
        }

        const [rows, totalRow] = await Promise.all([
          listed
            .orderBy('elements.elementKey')
            .orderBy('elements.id')
            .limit(page.limit)
            .offset(page.offset)
            .execute(),
          counted.executeTakeFirst(),
        ]);

        return {
          applicationId: appId,
          memoryVersionId: version.id,
          elements: rows.map(toElement),
          total: Number(totalRow?.total ?? 0),
        };
      });
    },
  );

  app.get<{ Params: { appId: string } }>(
    '/v1/memory/:appId/graph',
    { config: { permission: 'memory:read' } },
    async (request) => {
      principalOf(request);
      const appId = parseAppId(request.params);
      assertApplicationScope(request.extension?.applicationId, appId);

      return database.withTenant('memory-browse-graph', async (db) => {
        const version = await requireActiveOrEmpty(db, appId);
        if (version === null) {
          return { applicationId: appId, memoryVersionId: null, edges: [] };
        }

        const rows = await db
          .selectFrom('navEdges')
          .select([
            'id',
            'memoryVersionId',
            'fromScreen',
            'toScreen',
            'triggerElement',
            'preconditions',
            'confidence',
          ])
          .where('memoryVersionId', '=', version.id)
          .orderBy('fromScreen')
          .orderBy('id')
          .execute();

        return {
          applicationId: appId,
          memoryVersionId: version.id,
          edges: rows.map(toEdge),
        };
      });
    },
  );

  app.get<{ Params: { appId: string } }>(
    '/v1/memory/:appId/aliases',
    { config: { permission: 'memory:read' } },
    async (request) => {
      principalOf(request);
      const appId = parseAppId(request.params);
      assertApplicationScope(request.extension?.applicationId, appId);
      const page = parsePage(request.query);

      return database.withTenant('memory-browse-aliases', async (db) => {
        const version = await requireActiveOrEmpty(db, appId);
        if (version === null) {
          return { applicationId: appId, memoryVersionId: null, aliases: [], total: 0 };
        }

        const [rows, totalRow] = await Promise.all([
          db
            .selectFrom('aliases')
            .select([
              'id',
              'tenantId',
              'memoryVersionId',
              'phrase',
              'elementId',
              'stateFingerprint',
              'source',
              'hits',
              'createdAt',
            ])
            .where('memoryVersionId', '=', version.id)
            .orderBy('phrase')
            .orderBy('id')
            .limit(page.limit)
            .offset(page.offset)
            .execute(),
          db
            .selectFrom('aliases')
            .select((eb) => eb.fn.countAll<string>().as('total'))
            .where('memoryVersionId', '=', version.id)
            .executeTakeFirst(),
        ]);

        return {
          applicationId: appId,
          memoryVersionId: version.id,
          aliases: rows.map(toAlias),
          total: Number(totalRow?.total ?? 0),
        };
      });
    },
  );
}

async function requireActiveOrEmpty(
  db: Parameters<typeof findActiveMemoryVersion>[0],
  applicationId: string,
): Promise<{ readonly id: string } | null> {
  const application = await db
    .selectFrom('applications')
    .select('id')
    .where('id', '=', applicationId)
    .executeTakeFirst();
  if (application === undefined) {
    throw new GatewayError('validation_failed', 'unknown application for this tenant', {
      issues: [{ path: 'appId', message: 'unknown application for this tenant' }],
    });
  }

  const active = await findActiveMemoryVersion(db, applicationId);
  return active === undefined ? null : { id: active.id };
}

function toScreen(row: {
  id: string;
  memoryVersionId: string;
  routePattern: string;
  stateFingerprint: string;
  label: string;
  structuralHash: string;
  indexedAt: Date;
}): ScreenRow {
  return ScreenNode.parse({
    id: row.id,
    memoryVersionId: row.memoryVersionId,
    routePattern: row.routePattern,
    stateFingerprint: row.stateFingerprint,
    label: row.label,
    structuralHash: row.structuralHash,
    indexedAt: row.indexedAt.toISOString(),
  });
}

function toElement(row: {
  id: string;
  screenId: string;
  elementKey: string;
  fingerprint: unknown;
  confidence: string;
  stability: string;
}): ElementRow {
  return ElementRecord.parse({
    id: row.id,
    screenId: row.screenId,
    elementKey: row.elementKey,
    fingerprint: row.fingerprint,
    confidence: Number(row.confidence),
    stability: Number(row.stability),
  });
}

function toEdge(row: {
  id: string;
  memoryVersionId: string;
  fromScreen: string;
  toScreen: string;
  triggerElement: string;
  preconditions: unknown;
  confidence: string;
}): NavEdgeRecord {
  return NavEdge.parse({
    id: row.id,
    memoryVersionId: row.memoryVersionId,
    fromScreenId: row.fromScreen,
    toScreenId: row.toScreen,
    triggerElementId: row.triggerElement,
    preconditions: row.preconditions,
    confidence: Number(row.confidence),
  });
}

function toAlias(row: {
  id: string;
  tenantId: string;
  memoryVersionId: string;
  phrase: string;
  elementId: string;
  stateFingerprint: string | null;
  source: string;
  hits: number;
  createdAt: Date;
}): AliasRecord {
  return Alias.parse({
    id: row.id,
    tenantId: row.tenantId,
    memoryVersionId: row.memoryVersionId,
    phrase: row.phrase,
    elementId: row.elementId,
    stateFingerprint: row.stateFingerprint,
    source: row.source,
    hits: row.hits,
    createdAt: row.createdAt.toISOString(),
  });
}
