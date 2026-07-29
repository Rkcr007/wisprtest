import type { FastifyInstance } from 'fastify';
import {
  SessionCloseRequest,
  SessionOpenRequest,
  SessionStepBatch,
  type SessionTimeline,
  type SignedEvidence,
} from 'protocol';

import type { TenantDatabase } from '../db/pool.js';
import {
  closeSession,
  findSession,
  insertSteps,
  listSteps,
  openSession,
} from '../db/session-repository.js';
import { GatewayError } from '../errors.js';
import { keyBelongsToTenant, type EvidenceStore } from '../storage/evidence-store.js';
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
      for (const step of parsed.data.steps) {
        if (step.tier !== null) {
          metrics.tierTotal.add(1, { tier: step.tier, outcome: step.outcome });
        }
      }

      return await reply.code(200).send(result);
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
}
