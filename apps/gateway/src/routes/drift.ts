import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import {
  DriftDecisionRequest,
  DriftRaiseRequest,
  type DriftDecisionResponse,
  type DriftListResponse,
  type DriftRaiseResponse,
} from 'protocol';

import type { GatewayConfig } from '../config.js';
import type { TenantDatabase } from '../db/pool.js';
import {
  approveDriftReport,
  findDriftReport,
  listPendingReports,
  raiseDriftReport,
  rejectDriftReport,
} from '../db/drift-repository.js';
import { findSessionScope, recordAudit } from '../db/seed-repository.js';
import { DependencyUnavailableError, GatewayError } from '../errors.js';
import type { DriftJobDispatcher } from '../redis/drift-queue.js';
import type { GatewayMetrics } from '../telemetry/metrics.js';

/**
 * `/v1/drift` — notice that memory is wrong, and let a human decide what to do about it.
 *
 * The learning loop of ARCHITECTURE § 6, and the one place in the product where the product is
 * *not* allowed to be clever. From `BUILD-PLAN.md` Phase 17:
 *
 * > Human approval is REQUIRED before a memory version becomes active. Fully automatic
 * > self-healing is what destroyed trust in the previous generation of QA tools — it made tests
 * > pass that should have failed. WisprTest proposes; a human commits. Do not add an auto-approve
 * > path, even behind a flag.
 *
 * Three things enforce that rather than one: the RBAC permission (`drift:approve`, lead and
 * above), the CHECK constraint on `drift_reports`, and this route refusing a decision on a report
 * nobody has reconciled. None of them is decorative — the first two are what survive somebody
 * editing this file.
 *
 * ## Raising must never cost the tester anything
 *
 * The extension raises on route settle, which is a hot moment. So this route does the minimum:
 * one dedupe read, at most one insert, and a Redis publish whose failure is swallowed. A tester
 * whose staging Redis is down should be told nothing and lose nothing — the report is already in
 * Postgres and `observed_route` is enough to enqueue the reconcile again later.
 *
 * ## Approval is one transaction, and it has to be
 *
 * `memory_versions_one_active_per_application` is a partial unique index. Between superseding the
 * old version and activating the new one there is an instant with no active version, and a
 * snapshot load landing in it would tell a tester their application was never indexed. Inside a
 * transaction that instant does not exist.
 */

export interface DriftRoutesOptions {
  readonly config: GatewayConfig;
  readonly database: TenantDatabase;
  readonly metrics: GatewayMetrics;
  readonly dispatcher: DriftJobDispatcher;
  /** Drops the memory snapshot cached for a version, so the next attach reassembles it. */
  readonly invalidateSnapshot: (
    tenantId: string,
    applicationId: string,
    version: number,
  ) => Promise<void>;
}

interface Principal {
  readonly tenantId: string;
  readonly userId: string;
}

/** How many pending reports one page of the review queue returns. */
const PAGE_SIZE = 100;

export function registerDriftRoutes(app: FastifyInstance, options: DriftRoutesOptions): void {
  const { config, database, metrics, dispatcher, invalidateSnapshot } = options;

  function principalOf(request: { principal?: Principal }): Principal {
    const principal = request.principal;
    if (principal === undefined) {
      throw new GatewayError('unauthorized', 'authentication required');
    }
    return principal;
  }

  function invalid(message: string, path: string, detail: string): GatewayError {
    return new GatewayError('validation_failed', message, { issues: [{ path, message: detail }] });
  }

  app.post('/v1/drift', { config: { permission: 'session:write' } }, async (request, reply) => {
    const { tenantId } = principalOf(request);

    const parsed = DriftRaiseRequest.safeParse(request.body);
    if (!parsed.success) {
      throw new GatewayError('validation_failed', 'invalid drift report', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || 'root',
          message: issue.message,
        })),
      });
    }

    // The memory version comes from the session, never from the caller. A client that could name
    // the version it is reporting against could raise drift against a version it never loaded.
    const scope = await database.withTenant('drift-raise-scope', async (db) => {
      const found = await findSessionScope(db, parsed.data.sessionId);
      if (found === null) {
        throw invalid('unknown session for this tenant', 'sessionId', 'unknown session');
      }
      return found;
    });

    const raised = await database.withTenant('drift-raise', (db) =>
      raiseDriftReport(db, {
        tenantId,
        memoryVersionId: scope.memoryVersionId,
        screenId: parsed.data.screenId,
        routePattern: parsed.data.routePattern,
        observedRoute: parsed.data.route,
        stateFingerprint: parsed.data.stateFingerprint,
        expectedStructuralHash: parsed.data.expectedStructuralHash,
        observedStructuralHash: parsed.data.observedStructuralHash,
      }),
    );

    if (raised.created) {
      metrics.driftReportsTotal.add(1, { detected_by: 'extension' });

      try {
        await dispatcher.enqueue({
          jobId: randomUUID(),
          tenantId,
          applicationId: scope.applicationId,
          memoryVersionId: scope.memoryVersionId,
          driftReportId: raised.report.id,
          screenId: raised.report.screenId,
          routePattern: raised.report.routePattern,
          route: raised.report.observedRoute,
          deadlineMs: config.DRIFT_RECONCILE_TIMEOUT_MS,
          traceparent: null,
        });
      } catch (error: unknown) {
        // Deliberately swallowed. The report exists and carries the route, so the reconcile can
        // be enqueued again; failing the request instead would push a Redis outage onto a tester
        // who did nothing but look at a page, which is exactly what "never block" forbids.
        if (!(error instanceof DependencyUnavailableError)) throw error;
        request.log.warn(
          { event: 'drift.reconcile_not_enqueued', drift_report_id: raised.report.id },
          'drift report stored but the reconcile could not be queued',
        );
      }
    }

    const response: DriftRaiseResponse = { report: raised.report, created: raised.created };
    // 201 only when this observation created the report. A repeat sighting is a 200: nothing
    // changed, and the extension uses the distinction to decide whether to show its notice again.
    return await reply.code(raised.created ? 201 : 200).send(response);
  });

  app.get<{ Params: { appId: string } }>(
    '/v1/drift/:appId',
    { config: { permission: 'memory:read' } },
    async (request, reply) => {
      principalOf(request);

      const listed = await database.withTenant('drift-list', (db) =>
        listPendingReports(db, request.params.appId, PAGE_SIZE),
      );

      const response: DriftListResponse = {
        reports: [...listed.reports],
        total: listed.total,
      };
      return await reply.code(200).send(response);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/drift/:id/approve',
    { config: { permission: 'drift:approve' } },
    async (request, reply) => {
      const { tenantId, userId } = principalOf(request);

      const parsed = DriftDecisionRequest.safeParse(request.body);
      if (!parsed.success) {
        throw new GatewayError('validation_failed', 'invalid drift decision', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'root',
            message: issue.message,
          })),
        });
      }

      const decision = parsed.data;

      const report = await database.withTenant('drift-load', (db) =>
        findDriftReport(db, request.params.id),
      );
      if (report === null) {
        throw invalid('unknown drift report for this tenant', 'id', 'unknown report');
      }
      if (report.status === 'approved' || report.status === 'rejected') {
        throw new GatewayError('validation_failed', 'this report has already been decided', {
          issues: [{ path: 'id', message: `the report is already ${report.status}` }],
        });
      }

      if (decision.decision === 'reject') {
        const rejected = await database.withTenant('drift-reject', async (db) => {
          const updated = await rejectDriftReport(db, report.id, userId);
          await recordAudit(db, {
            tenantId,
            actor: userId,
            action: 'drift.rejected',
            target: report.id,
            metadata: {
              memoryVersionId: report.memoryVersionId,
              candidateMemoryVersionId: report.candidateMemoryVersionId,
              routePattern: report.routePattern,
              reason: decision.reason,
            },
          });
          return updated;
        });

        metrics.driftDecisionsTotal.add(1, { decision: 'rejected' });

        const response: DriftDecisionResponse = {
          report: rejected,
          newMemoryVersionId: null,
          aliasMigration: null,
        };
        return await reply.code(200).send(response);
      }

      // An approval activates a version a reconcile built. A report nobody has reconciled has
      // nothing to activate, and approving it would report success while leaving the application
      // on the memory the tester already knows is wrong.
      if (report.status !== 'diffed') {
        throw new GatewayError(
          'validation_failed',
          'this report has not been reconciled yet, so there is nothing to activate',
          { issues: [{ path: 'id', message: `the report is ${report.status}` }] },
        );
      }

      const outcome = await database.withTenant('drift-approve', async (db) => {
        const approved = await approveDriftReport(db, report, userId);
        await recordAudit(db, {
          tenantId,
          actor: userId,
          action: 'drift.approved',
          target: report.id,
          metadata: {
            supersededMemoryVersionId: report.memoryVersionId,
            activatedMemoryVersionId: approved.newMemoryVersionId,
            routePattern: report.routePattern,
            // Counts only. The phrases themselves are the tester's vocabulary and an audit log is
            // one of the sinks CLAUDE.md's PII rule is about.
            aliasesMigrated: approved.migrated,
            aliasesDropped: approved.dropped,
          },
        });
        return approved;
      });

      // Outside the transaction, and after it. The cache holds the superseded version's snapshot;
      // dropping it before the commit would let a concurrent attach repopulate it from a version
      // that is about to stop being active.
      await invalidateSnapshot(tenantId, outcome.applicationId, outcome.supersededVersion);

      metrics.driftDecisionsTotal.add(1, { decision: 'approved' });

      const carried = outcome.migrated + outcome.dropped;
      const response: DriftDecisionResponse = {
        report: outcome.report,
        newMemoryVersionId: outcome.newMemoryVersionId,
        aliasMigration: {
          migrated: outcome.migrated,
          dropped: outcome.dropped,
          // A version whose screens nobody had taught any vocabulary loses nothing, so the rate
          // is 1 rather than a division by zero dressed up as a score.
          rate: carried === 0 ? 1 : outcome.migrated / carried,
        },
      };
      return await reply.code(200).send(response);
    },
  );
}
