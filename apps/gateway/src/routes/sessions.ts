import type { FastifyInstance } from 'fastify';
import {
  EvidenceUploadRequest,
  FalseExecutionReportRequest,
  FalseExecutionWithdrawRequest,
  SessionCloseRequest,
  SessionOpenRequest,
  SessionStepBatch,
  type FalseExecutionReport,
  type SessionTimeline,
  type SignedEvidence,
} from 'protocol';
import { z } from 'zod';

import type { TenantDatabase } from '../db/pool.js';
import { listLedgerForSession, recordAudit } from '../db/seed-repository.js';
import {
  closeSession,
  fileFalseExecutionReport,
  findSession,
  insertSteps,
  listFalseExecutionReports,
  listSessions,
  listSteps,
  openSession,
  withdrawFalseExecutionReport,
} from '../db/session-repository.js';
import { GatewayError } from '../errors.js';
import { parsePage } from '../http/page.js';
import { evidenceKey, keyBelongsToTenant, type EvidenceStore } from '../storage/evidence-store.js';
import type { GatewayMetrics } from '../telemetry/metrics.js';

/**
 * `/v1/sessions` — opening, closing, ingesting steps, and reading a timeline back.
 *
 * A session is the replayable record of a tester's sitting: what they said, what it resolved to,
 * at which tier, how long it took, and what it did (docs/ARCHITECTURE.md § 4). It is the evidence
 * behind a bug report and the source of the tier-distribution metric that says whether the
 * compounding loop is working, so the properties that matter here are about *integrity* rather
 * than throughput.
 *
 * ## Sessions are immutable once closed
 *
 * The phase is explicit: "Enforce it in the API, not just the UI." Closing stamps `ended_at` in a
 * conditional update, and step ingest is guarded by a subquery requiring the session to still be
 * open — so a late flush from a tab that closed mid-batch is refused with a typed `session_closed`
 * naming the session and when it ended, rather than quietly appended after the end of a timeline.
 *
 * ## Ingest is idempotent, because the extension retries
 *
 * The buffer flushes every 5s and on detach, and retries what it could not deliver. Ingest is
 * therefore idempotent on `(sessionId, ordinal)`: the same batch twice is one timeline. The
 * response splits `inserted` from `duplicates` so an entirely-duplicate flush reads as the normal
 * outcome it is — the previous attempt landed and the buffer was never told.
 *
 * ## Evidence never crosses inline
 *
 * Steps carry storage keys and content hashes; the timeline resolves those keys to short-lived
 * signed URLs. The console renders a screenshot without ever holding an object-storage credential,
 * and the hash still verifies against the bytes it fetches.
 */

export interface SessionRoutesOptions {
  readonly database: TenantDatabase;
  readonly metrics: GatewayMetrics;
  readonly evidence: EvidenceStore;
}

interface SessionParams {
  readonly id: string;
}

const SessionListQuery = z.object({
  applicationId: z.uuid().optional(),
});

export function registerSessionRoutes(app: FastifyInstance, options: SessionRoutesOptions): void {
  const { database, metrics, evidence } = options;

  /** The authenticated principal, or a typed 401. Every route here needs both ids. */
  function principalOf(request: { principal?: { tenantId: string; userId: string } }): {
    tenantId: string;
    userId: string;
  } {
    const principal = request.principal;
    if (principal === undefined) {
      // Unreachable: these routes require authentication. Checked rather than asserted because a
      // session opened without a principal is a timeline attributed to nobody.
      throw new GatewayError('unauthorized', 'authentication required');
    }
    return principal;
  }

  function invalid(message: string, path: string, detail: string): GatewayError {
    return new GatewayError('validation_failed', message, {
      issues: [{ path, message: detail }],
    });
  }

  app.get('/v1/sessions', { config: { permission: 'memory:read' } }, async (request) => {
    principalOf(request);
    const page = parsePage(request.query);
    const filter = SessionListQuery.safeParse(request.query);
    if (!filter.success) {
      throw new GatewayError('validation_failed', 'invalid session list query', {
        issues: filter.error.issues.map((issue) => ({
          path: issue.path.join('.') || 'root',
          message: issue.message,
        })),
      });
    }

    return database.withTenant('session-list', (db) =>
      listSessions(db, {
        ...(filter.data.applicationId === undefined
          ? {}
          : { applicationId: filter.data.applicationId }),
        limit: page.limit,
        offset: page.offset,
      }),
    );
  });

  app.get<{ Params: SessionParams }>(
    '/v1/sessions/:id/ledger',
    { config: { permission: 'memory:read' } },
    async (request) => {
      principalOf(request);
      return database.withTenant('session-ledger', async (db) => {
        const session = await findSession(db, request.params.id);
        if (session === null) {
          throw invalid('unknown session', 'id', 'unknown session for this tenant');
        }
        const entries = await listLedgerForSession(db, session.id);
        return { sessionId: session.id, entries };
      });
    },
  );

  app.post('/v1/sessions', { config: { permission: 'session:write' } }, async (request, reply) => {
    const { tenantId, userId } = principalOf(request);

    const parsed = SessionOpenRequest.safeParse(request.body);
    if (!parsed.success) {
      throw new GatewayError('validation_failed', 'invalid session open request', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || 'root',
          message: issue.message,
        })),
      });
    }

    const session = await database.withTenant('session-open', async (db) => {
      // The composite foreign keys prove the application and memory version belong to this
      // tenant; a cross-tenant id fails the constraint rather than opening a session that
      // straddles two. The check here turns that into a legible 422 instead of a 500.
      const version = await db
        .selectFrom('memoryVersions')
        .select(['id', 'applicationId'])
        .where('id', '=', parsed.data.memoryVersionId)
        .executeTakeFirst();

      if (version === undefined) {
        throw invalid(
          'unknown memory version for this tenant',
          'memoryVersionId',
          'unknown memory version for this tenant',
        );
      }
      if (version.applicationId !== parsed.data.applicationId) {
        throw invalid(
          'the memory version does not belong to that application',
          'memoryVersionId',
          'memory version belongs to a different application',
        );
      }

      return openSession(db, {
        tenantId,
        userId,
        applicationId: parsed.data.applicationId,
        memoryVersionId: parsed.data.memoryVersionId,
      });
    });

    return await reply.code(201).send(session);
  });

  app.patch<{ Params: SessionParams }>(
    '/v1/sessions/:id',
    { config: { permission: 'session:write' } },
    async (request, reply) => {
      principalOf(request);

      const parsed = SessionCloseRequest.safeParse(request.body);
      if (!parsed.success) {
        // An empty or malformed body must not close a session by accident, so the transition is
        // named explicitly and anything else is refused.
        throw new GatewayError('validation_failed', 'invalid session close request', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'root',
            message: issue.message,
          })),
        });
      }

      const result = await database.withTenant('session-close', (db) =>
        closeSession(db, request.params.id),
      );

      if (result.outcome === 'missing') {
        throw invalid('unknown session', 'id', 'unknown session for this tenant');
      }
      if (result.outcome === 'already_closed') {
        // Closing twice is a conflict rather than a no-op: the second caller believes it ended a
        // session it did not, and the timestamp it would report is not the one on record.
        throw new GatewayError('session_closed', 'that session is already closed', {
          sessionId: result.session?.id,
          endedAt: result.session?.endedAt,
        });
      }

      return await reply.code(200).send(result.session);
    },
  );

  app.post<{ Params: SessionParams }>(
    '/v1/sessions/:id/steps',
    { config: { permission: 'session:write' } },
    async (request, reply) => {
      const { tenantId } = principalOf(request);
      const sessionId = request.params.id;

      const parsed = SessionStepBatch.safeParse(request.body);
      if (!parsed.success) {
        throw new GatewayError('validation_failed', 'invalid session step batch', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'root',
            message: issue.message,
          })),
        });
      }

      // A buffer that survived a service-worker restart could hold steps from an earlier session.
      // Refusing the batch is what stops one session's steps spilling into another's timeline.
      const foreign = parsed.data.steps.find((step) => step.sessionId !== sessionId);
      if (foreign !== undefined) {
        throw invalid(
          'a step names a different session than the one being written to',
          'steps',
          `step ${String(foreign.ordinal)} belongs to session ${foreign.sessionId}`,
        );
      }

      // The repository locks the session row and decides in one statement whether the batch may
      // land, so a close arriving mid-flush cannot slip between a check here and the write there.
      const outcome = await database.withTenant('session-steps', (db) =>
        insertSteps(db, { tenantId, sessionId, steps: parsed.data.steps }),
      );

      if (outcome.kind === 'missing') {
        throw invalid('unknown session', 'id', 'unknown session for this tenant');
      }
      if (outcome.kind === 'closed') {
        throw new GatewayError('session_closed', 'that session is closed', {
          sessionId: outcome.session.id,
          endedAt: outcome.session.endedAt,
        });
      }
      const result = outcome.result;

      // The tier distribution over time is the health metric for the compounding loop
      // (docs/ARCHITECTURE.md § 6), and ingest is where the gateway learns what actually ran.
      //
      // `sessionStepsTotal` is counted for *every* step, deliberately unlike `tierTotal`, which
      // is skipped when the tier is null. It is the denominator of the false execution rate, and
      // a denominator that dropped the steps which never resolved would flatter the ratio: those
      // are the hardest cases, not the irrelevant ones.
      for (const step of parsed.data.steps) {
        metrics.sessionStepsTotal.add(1, { outcome: step.outcome });
        if (step.tier !== null) {
          metrics.tierTotal.add(1, { tier: step.tier, outcome: step.outcome });
        }
      }

      return await reply.code(200).send(result);
    },
  );

  app.post<{ Params: SessionParams }>(
    '/v1/sessions/:id/evidence',
    { config: { permission: 'session:write' } },
    async (request, reply) => {
      const { tenantId } = principalOf(request);
      const sessionId = request.params.id;

      const parsed = EvidenceUploadRequest.safeParse(request.body);
      if (!parsed.success) {
        throw new GatewayError('validation_failed', 'invalid evidence upload request', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'root',
            message: issue.message,
          })),
        });
      }

      // A ticket is only issued for a session that could still receive the step it belongs to.
      // Evidence for a closed session would be an object nothing references — paid for, stored,
      // and unreachable from any timeline.
      const session = await database.withTenant('session-evidence', (db) =>
        findSession(db, sessionId),
      );
      if (session === null) {
        throw invalid('unknown session', 'id', 'unknown session for this tenant');
      }
      if (session.endedAt !== null) {
        throw new GatewayError('session_closed', 'that session is closed', {
          sessionId: session.id,
          endedAt: session.endedAt,
        });
      }

      // The key is derived here, never accepted from the caller: a client-supplied key is a
      // client-chosen path, and the tenant prefix is the only thing keeping one tenant's evidence
      // out of another's.
      const key = evidenceKey({
        tenantId,
        sessionId,
        stepOrdinal: parsed.data.stepOrdinal,
        kind: parsed.data.kind,
        contentHash: parsed.data.contentHash,
      });

      const { url, expiresAt } = await evidence.signedUploadUrl(key, parsed.data.contentType);

      return await reply
        .code(200)
        .header('cache-control', 'private, no-store')
        .send({ storageKey: key, uploadUrl: url, expiresAt });
    },
  );

  app.get<{ Params: SessionParams }>(
    '/v1/sessions/:id',
    { config: { permission: 'memory:read' } },
    async (request, reply) => {
      const { tenantId } = principalOf(request);
      const sessionId = request.params.id;

      const loaded = await database.withTenant('session-timeline', async (db) => {
        const session = await findSession(db, sessionId);
        if (session === null) return null;
        return { session, steps: await listSteps(db, sessionId) };
      });

      if (loaded === null) {
        throw invalid('unknown session', 'id', 'unknown session for this tenant');
      }

      // One signed URL per distinct key, not per reference: a screenshot cited by two steps is one
      // object, and signing it twice would hand out two links to the same bytes.
      const keys = new Set<string>();
      for (const step of loaded.steps) {
        for (const ref of step.evidence) keys.add(ref.storageKey);
      }

      const signed: SignedEvidence[] = [];
      for (const key of keys) {
        // Defence in depth. RLS already proved the session is this tenant's, so its steps are too;
        // this refuses to sign a key that does not sit under the tenant's prefix anyway, so a row
        // written by some future code path with a bad key cannot become a cross-tenant URL.
        if (!keyBelongsToTenant(key, tenantId)) continue;
        const { url, expiresAt } = await evidence.signedUrl(key);
        signed.push({ storageKey: key, url, expiresAt });
      }

      const timeline: SessionTimeline = {
        session: loaded.session,
        steps: [...loaded.steps],
        evidence: signed,
      };

      return await reply
        .code(200)
        // A timeline is a tenant's evidence; a shared cache must never hold it.
        .header('cache-control', 'private, no-store')
        .send(timeline);
    },
  );

  /**
   * `POST /v1/sessions/:id/false-executions` — a tester saying an action was wrong.
   *
   * The producer for `wispr_false_execution_total`, and so the numerator of the release gate
   * CLAUDE.md sets at < 0.1%. Until this route existed the budget was asserted by the Phase 10
   * speculation test rather than measured, because a false execution is not something the runtime
   * can detect: the resolver was confident and the dispatch succeeded. Only the person watching
   * the screen knows.
   *
   * `session:write` rather than a new permission — the same capability that writes the steps this
   * judges, already carried by a tester's extension token and by their console session.
   *
   * Note what is *not* checked: whether the session is still open. Step ingest refuses a closed
   * session because a timeline is evidence and evidence does not grow afterwards. A report is not
   * part of the timeline; it is a judgement about it, and the moment a tester is most likely to
   * notice a wrong click is reviewing the session later. See `fileFalseExecutionReport`.
   */
  app.post<{ Params: SessionParams }>(
    '/v1/sessions/:id/false-executions',
    { config: { permission: 'session:write' } },
    async (request, reply) => {
      const { tenantId, userId } = principalOf(request);
      const sessionId = request.params.id;

      const parsed = FalseExecutionReportRequest.safeParse(request.body);
      if (!parsed.success) {
        throw new GatewayError('validation_failed', 'invalid false execution report', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'root',
            message: issue.message,
          })),
        });
      }

      const outcome = await database.withTenant('false-execution-file', (db) =>
        fileFalseExecutionReport(db, {
          tenantId,
          sessionId,
          reportedBy: userId,
          request: parsed.data,
        }),
      );

      if (outcome.kind === 'no_such_session') {
        throw invalid('unknown session', 'id', 'unknown session for this tenant');
      }
      if (outcome.kind === 'no_such_step') {
        throw invalid(
          'no step at that ordinal',
          'stepOrdinal',
          `session ${sessionId} has no step at ordinal ${String(parsed.data.stepOrdinal)}`,
        );
      }
      if (outcome.kind === 'already_open') {
        // Not an error. A second report on the same step is the tester saying the same thing
        // twice, and answering 200 with the report that stands keeps the counter honest — one
        // wrong click is one false execution however many times it is reported.
        return await reply.code(200).send(outcome.report);
      }

      // Counted only on a genuinely new report, for the same reason.
      metrics.falseExecutionTotal.add(1, { reason: outcome.report.reason });

      return await reply.code(201).send(outcome.report);
    },
  );

  /**
   * `POST /v1/sessions/:id/false-executions/:ordinal/withdraw` — retracting one filed by mistake.
   *
   * Withdrawing moves a number that gates releases, which is why the reason is required and why
   * this is written to `audit_log`: `withdrawn_by` is nulled if the account is later deleted, so
   * the audit entry is the durable record of who did it (docs/ARCHITECTURE.md § 8).
   *
   * The withdrawal is a second counter rather than a decrement — an OTel Counter is monotonic.
   * The gate reads `(filed − withdrawn) / steps executed`.
   */
  app.post<{ Params: SessionParams & { readonly ordinal: string } }>(
    '/v1/sessions/:id/false-executions/:ordinal/withdraw',
    { config: { permission: 'session:write' } },
    async (request, reply) => {
      const { tenantId, userId } = principalOf(request);
      const sessionId = request.params.id;

      const ordinal = Number(request.params.ordinal);
      if (!Number.isInteger(ordinal) || ordinal < 0) {
        throw invalid('invalid step ordinal', 'ordinal', 'ordinal must be a non-negative integer');
      }

      const parsed = FalseExecutionWithdrawRequest.safeParse(request.body);
      if (!parsed.success) {
        throw new GatewayError('validation_failed', 'invalid withdrawal', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'root',
            message: issue.message,
          })),
        });
      }

      const outcome = await database.withTenant('false-execution-withdraw', async (db) => {
        const result = await withdrawFalseExecutionReport(db, {
          sessionId,
          stepOrdinal: ordinal,
          withdrawnBy: userId,
          reason: parsed.data.reason,
        });

        if (result.kind === 'withdrawn') {
          // Inside the same transaction as the update: an audit entry that could be lost while
          // the withdrawal stood would defeat the point of recording it.
          await recordAudit(db, {
            tenantId,
            actor: userId,
            action: 'false_execution.withdraw',
            target: `${sessionId}#${String(ordinal)}`,
            // The reason is operational text about a process decision, not screen content.
            metadata: { reason: parsed.data.reason, reportId: result.report.id },
          });
        }

        return result;
      });

      if (outcome.kind === 'not_open') {
        throw invalid(
          'no open report at that ordinal',
          'ordinal',
          'there is no open false-execution report for that step',
        );
      }

      metrics.falseExecutionWithdrawnTotal.add(1, { reason: outcome.report.reason });

      return await reply.code(200).send(outcome.report);
    },
  );

  /**
   * `GET /v1/sessions/:id/false-executions` — the reports filed against one session.
   *
   * `memory:read`, matching the timeline read beside it: seeing what a tester reported is a read
   * of their session, not a write to it. Withdrawn reports are included — a list that hid them
   * would make a retraction look like it never happened.
   */
  app.get<{ Params: SessionParams }>(
    '/v1/sessions/:id/false-executions',
    { config: { permission: 'memory:read' } },
    async (request, reply) => {
      principalOf(request);
      const sessionId = request.params.id;

      const session = await database.withTenant('false-execution-session', (db) =>
        findSession(db, sessionId),
      );
      if (session === null) {
        throw invalid('unknown session', 'id', 'unknown session for this tenant');
      }

      const reports: readonly FalseExecutionReport[] = await database.withTenant(
        'false-execution-list',
        (db) => listFalseExecutionReports(db, sessionId),
      );

      return await reply
        .code(200)
        // A report may carry a redacted note about a tenant's screen. Same rule as the timeline.
        .header('cache-control', 'private, no-store')
        .send(reports);
    },
  );
}
