import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { TenantDatabase } from '../db/pool.js';
import { GatewayError } from '../errors.js';
import { parsePage } from '../http/page.js';
import { isRole, PERMISSIONS_BY_ROLE, ROLES } from '../rbac/permissions.js';

/**
 * Tenant administration: team, the RBAC matrix, the read-only action/redaction policy, audit.
 *
 * `admin:manage` is owner-only. The policy is not writable here. Action class R/C/A/S is the
 * reversibility taxonomy in CLAUDE.md; redaction is the fingerprint pipeline. A UI that let an
 * owner flip "Class C may speculate" would be the single worst product bug this system can ship.
 */

const UserIdParams = z.strictObject({
  id: z.uuid(),
});

const PatchUserBody = z.strictObject({
  role: z.enum(ROLES),
});

export interface AdminRoutesOptions {
  readonly database: TenantDatabase;
}

export function registerAdminRoutes(app: FastifyInstance, options: AdminRoutesOptions): void {
  const { database } = options;

  function principalOf(request: {
    principal?: { tenantId: string; userId: string };
  }): { tenantId: string; userId: string } {
    const principal = request.principal;
    if (principal === undefined) {
      throw new GatewayError('unauthorized', 'authentication required');
    }
    return principal;
  }

  function invalid(message: string, path: string, detail: string): GatewayError {
    return new GatewayError('validation_failed', message, { issues: [{ path, message: detail }] });
  }

  app.get('/v1/admin/users', { config: { permission: 'admin:manage' } }, async (request) => {
    principalOf(request);
    return database.withTenant('admin-list-users', async (db) => {
      const rows = await db
        .selectFrom('users')
        .select(['id', 'email', 'role', 'createdAt'])
        .orderBy('email')
        .execute();
      return {
        users: rows.map((row) => ({
          id: row.id,
          email: row.email,
          role: row.role,
          createdAt: row.createdAt.toISOString(),
        })),
      };
    });
  });

  app.patch<{ Params: { id: string } }>(
    '/v1/admin/users/:id',
    { config: { permission: 'admin:manage' } },
    async (request) => {
      const { tenantId, userId } = principalOf(request);
      const params = UserIdParams.safeParse(request.params);
      if (!params.success) {
        throw invalid('unknown user', 'id', 'unknown user for this tenant');
      }
      const body = PatchUserBody.safeParse(request.body);
      if (!body.success) {
        throw new GatewayError('validation_failed', 'invalid role change', {
          issues: body.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'root',
            message: issue.message,
          })),
        });
      }

      return database.withTenant('admin-patch-user', async (db) => {
        const target = await db
          .selectFrom('users')
          .select(['id', 'email', 'role'])
          .where('id', '=', params.data.id)
          .executeTakeFirst();
        if (target === undefined) {
          throw invalid('unknown user', 'id', 'unknown user for this tenant');
        }
        if (!isRole(target.role)) {
          throw new GatewayError('internal', 'stored user role is not a known role', {
            userId: target.id,
          });
        }

        if (target.role === 'owner' && body.data.role !== 'owner') {
          const owners = await db
            .selectFrom('users')
            .select((eb) => eb.fn.countAll<string>().as('total'))
            .where('role', '=', 'owner')
            .executeTakeFirst();
          if (Number(owners?.total ?? 0) <= 1) {
            throw invalid(
              'the last owner cannot be demoted',
              'role',
              'the last owner of this tenant cannot be demoted',
            );
          }
        }

        const updated = await db
          .updateTable('users')
          .set({ role: body.data.role })
          .where('id', '=', target.id)
          .returning(['id', 'email', 'role', 'createdAt'])
          .executeTakeFirstOrThrow();

        await db
          .insertInto('auditLog')
          .values({
            tenantId,
            actor: `user:${userId}`,
            action: 'user.role_changed',
            target: `user:${target.id}`,
            metadata: JSON.stringify({ from: target.role, to: body.data.role }),
          })
          .execute();

        return {
          id: updated.id,
          email: updated.email,
          role: updated.role,
          createdAt: updated.createdAt.toISOString(),
        };
      });
    },
  );

  app.get('/v1/admin/audit', { config: { permission: 'admin:manage' } }, async (request) => {
    principalOf(request);
    const page = parsePage(request.query);
    return database.withTenant('admin-list-audit', async (db) => {
      const [rows, totalRow] = await Promise.all([
        db
          .selectFrom('auditLog')
          .select(['id', 'actor', 'action', 'target', 'metadata', 'createdAt'])
          .orderBy('createdAt', 'desc')
          .orderBy('id', 'desc')
          .limit(page.limit)
          .offset(page.offset)
          .execute(),
        db
          .selectFrom('auditLog')
          .select((eb) => eb.fn.countAll<string>().as('total'))
          .executeTakeFirst(),
      ]);

      return {
        entries: rows.map((row) => ({
          id: row.id,
          actor: row.actor,
          action: row.action,
          target: row.target,
          metadata: row.metadata,
          createdAt: row.createdAt.toISOString(),
        })),
        total: Number(totalRow?.total ?? 0),
      };
    });
  });

  app.get('/v1/admin/policy', { config: { permission: 'admin:manage' } }, async (request) => {
    principalOf(request);
    return {
      writable: false,
      roles: ROLES,
      permissionsByRole: PERMISSIONS_BY_ROLE,
      reversibility: REVERSIBILITY_POLICY,
      redaction: REDACTION_POLICY,
    };
  });
}

const REVERSIBILITY_POLICY = [
  {
    class: 'R',
    meaning: 'focus, hover, scroll, expand, read-only navigation',
    speculative: true,
    confirmation: false,
  },
  {
    class: 'C',
    meaning: 'submit, delete, approve, any state mutation',
    speculative: false,
    confirmation: true,
  },
  {
    class: 'A',
    meaning:
      'resolver confidence below threshold, or any resolution on a screen whose structural hash no longer matches memory',
    speculative: false,
    confirmation: true,
    preStageOnly: true,
  },
  {
    class: 'S',
    meaning: 'test data creation',
    speculative: false,
    confirmation: true,
    previewRequired: true,
  },
] as const;

const REDACTION_POLICY = {
  stores: 'structure, never content',
  accessibleNames: 'redacted, then hashed; only the digest and the redacted display form are persisted',
  masks: ['email', 'amount', 'phone', 'number'] as const,
  elementTextInLogs: false,
  customerDataInModelPrompts: false,
  writable: false,
} as const;

