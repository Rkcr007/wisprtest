import type { FastifyInstance } from 'fastify';
import {
  SeedExecuteRequest,
  SeedPlanRequest,
  SeedRevertRequest,
  type CompositionPlan,
  type EntitySchema,
  type SeedExecuteResponse,
  type SeedLedgerEntry,
  type SeedNodePreview,
  type SeedPlanResponse,
  type SeedRevertOutcome,
  type SeedRevertResponse,
} from 'protocol';

import type { ComposerClient } from '../composer/client.js';
import type { GatewayConfig } from '../config.js';
import type { TenantDatabase } from '../db/pool.js';
import {
  findLedgerEntry,
  findSeedPolicy,
  findSessionScope,
  insertLedgerEntry,
  listOutstandingForSession,
  loadEntitySchemas,
  markReverted,
  recordAudit,
  type SessionScope,
} from '../db/seed-repository.js';
import { GatewayError } from '../errors.js';
import { orderDescriptors, runChain } from '../materializers/chain.js';
import { createUiMaterializer } from '../materializers/ui.js';
import type { Materializer } from '../materializers/types.js';
import type { SeedJobDispatcher, SeedPlanStore } from '../redis/seed-queue.js';
import type { GatewayMetrics } from '../telemetry/metrics.js';

/**
 * `/v1/seed` — compose a plan, approve it, undo it.
 *
 * The three routes are three answers to the question docs/TEST-DATA-ENGINE.md § 6 poses: seeding
 * is action class **S**, so it is never speculative and never silent. `plan` writes nothing;
 * `execute` writes only what a human approved; `revert` undoes it.
 *
 * ## The plan never round-trips through the client
 *
 * `plan` holds the composed plan and returns an id. `execute` sends that id back and the gateway
 * materializes the plan it is already holding. That is the whole mechanism behind "the bytes that
 * were previewed are the bytes that get written" — a client has no way to describe a record, so
 * it has no way to approve one the tester never saw.
 *
 * ## Policy is enforced here, and every attempt is audited
 *
 * Production is blocked unless an application has been explicitly and auditably opted in, which
 * the database decides (`applications.seeding_allowed`) and this route obeys. Refusals are
 * written to `audit_log` alongside the writes: an audit trail that records only what succeeded
 * answers none of the questions an audit is for.
 *
 * ## Reverting is reverse dependency order, and partial success is normal
 *
 * A session's outstanding entries are undone newest first, which is reverse insertion order and
 * therefore reverse dependency order — the row that points at another goes before the row it
 * points at. Each entry reports its own outcome, because "three of four were removed, and here is
 * why the fourth was not" is more useful than one failure for the batch.
 */

export interface SeedRoutesOptions {
  readonly config: GatewayConfig;
  readonly database: TenantDatabase;
  readonly metrics: GatewayMetrics;
  readonly composer: ComposerClient;
  readonly plans: SeedPlanStore;
  readonly dispatcher: SeedJobDispatcher;
}

interface Principal {
  readonly tenantId: string;
  readonly userId: string;
}

export function registerSeedRoutes(app: FastifyInstance, options: SeedRoutesOptions): void {
  const { config, database, metrics, composer, plans, dispatcher } = options;

  function principalOf(request: { principal?: Principal }): Principal {
    const principal = request.principal;
    if (principal === undefined) {
      // Unreachable: these routes require authentication. Checked rather than asserted because a
      // seed attributed to nobody is a write into a customer's application with no owner.
      throw new GatewayError('unauthorized', 'authentication required');
    }
    return principal;
  }

  function invalid(message: string, path: string, detail: string): GatewayError {
    return new GatewayError('validation_failed', message, { issues: [{ path, message: detail }] });
  }

  /**
   * The session's scope, and the policy that governs writing to its application.
   *
   * Both are read from the database rather than taken from the request. The memory version in
   * particular: a plan composed against one version and materialized against another would fill a
   * form that no longer exists.
   */
  async function scopeFor(
    tenantId: string,
    userId: string,
    sessionId: string,
    applicationId: string | null,
    action: string,
  ): Promise<SessionScope> {
    const loaded = await database.withTenant(action, async (db) => {
      const scope = await findSessionScope(db, sessionId);
      if (scope === null) {
        throw invalid('unknown session for this tenant', 'sessionId', 'unknown session');
      }
      if (!scope.open) {
        throw new GatewayError('session_closed', 'the session is closed', { sessionId });
      }
      if (applicationId !== null && applicationId !== scope.applicationId) {
        throw invalid(
          'the session does not belong to that application',
          'applicationId',
          'session belongs to a different application',
        );
      }

      const policy = await findSeedPolicy(db, scope.applicationId);
      if (policy === null) {
        throw invalid(
          'unknown application for this tenant',
          'applicationId',
          'unknown application',
        );
      }

      return { scope, policy };
    });

    if (!loaded.policy.allowed) {
      // Audited in its own transaction, because the refusal is thrown and a throw inside
      // `withTenant` rolls the transaction back — the audit row would go with it, and an attempt
      // to seed production would leave no trace at all. Written first, so the record exists even
      // if the response never reaches the caller.
      await database.withTenant(`${action}-refused`, (db) =>
        recordAudit(db, {
          tenantId,
          actor: userId,
          action: `${action}.refused`,
          target: loaded.scope.applicationId,
          metadata: {
            reason: 'seeding_forbidden',
            environment: loaded.policy.environment,
            sessionId,
          },
        }),
      );

      throw new GatewayError(
        'seeding_forbidden',
        `seeding is not enabled for this ${loaded.policy.environment} application`,
        { applicationId: loaded.scope.applicationId, environment: loaded.policy.environment },
      );
    }

    return loaded.scope;
  }

  app.post('/v1/seed/plan', { config: { permission: 'seed:plan' } }, async (request, reply) => {
    const { tenantId, userId } = principalOf(request);

    const parsed = SeedPlanRequest.safeParse(request.body);
    if (!parsed.success) {
      throw new GatewayError('validation_failed', 'invalid seed plan request', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || 'root',
          message: issue.message,
        })),
      });
    }

    const startedAt = performance.now();
    const scope = await scopeFor(
      tenantId,
      userId,
      parsed.data.sessionId,
      parsed.data.applicationId,
      'seed-plan',
    );

    const loaded = await database.withTenant('seed-schemas', (db) =>
      loadEntitySchemas(db, scope.memoryVersionId),
    );

    if (loaded.schemas.length === 0) {
      // A refusal, not a failure. § 7: "Schema confidence too low to compose → refuse with the
      // specific missing field; offer to index the create form." With no schemas at all there is
      // no field to name, and the actionable thing is the index.
      throw new GatewayError(
        'schema_confidence_too_low',
        'this application has no learned entity schemas — index it before seeding',
        { entity: 'unknown', missingFields: [], confidence: 0, threshold: 1 },
      );
    }

    const composition = await composer.compose({
      tenantId,
      sessionId: parsed.data.sessionId,
      memoryVersionId: scope.memoryVersionId,
      utterance: parsed.data.utterance,
      schemas: [...loaded.schemas],
      runtimeState: parsed.data.runtimeState,
      existingRecords: parsed.data.existingRecords,
      // Constraint aliases are written back by the composer and persisted by whoever owns that
      // corpus; none are read yet, so every parse starts from the learned vocabularies. That
      // costs a model call on a novel phrasing and nothing on a familiar one.
      aliases: [],
      now: new Date().toISOString(),
      seed: parsed.data.seed,
    });

    metrics.seedPlanLatencyMs.record(performance.now() - startedAt, {
      outcome: composition.outcome.kind,
    });

    if (composition.outcome.kind !== 'planned') {
      // A conflict and a refusal are answers. They travel back with a 200 and the explanation the
      // tester is shown, because the request was understood — it is the *utterance* that could
      // not be satisfied, and an HTTP error would tell the extension to retry it.
      const response: SeedPlanResponse = {
        composition,
        planId: null,
        preview: [],
        expiresAt: null,
      };
      return await reply.code(200).send(response);
    }

    const plan = composition.outcome.plan;
    await plans.hold(plan, config.SEED_PLAN_TTL_SECONDS);

    const response: SeedPlanResponse = {
      composition,
      planId: plan.id,
      preview: previewFor(plan, loaded.schemas, loaded.deleteFlows),
      expiresAt: new Date(Date.now() + config.SEED_PLAN_TTL_SECONDS * 1000).toISOString(),
    };
    return await reply.code(200).send(response);
  });

  app.post(
    '/v1/seed/execute',
    { config: { permission: 'seed:execute' } },
    async (request, reply) => {
      const { tenantId, userId } = principalOf(request);

      const parsed = SeedExecuteRequest.safeParse(request.body);
      if (!parsed.success) {
        throw new GatewayError('validation_failed', 'invalid seed execute request', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'root',
            message: issue.message,
          })),
        });
      }

      const scope = await scopeFor(tenantId, userId, parsed.data.sessionId, null, 'seed-execute');

      const plan = await plans.take(tenantId, parsed.data.planId);
      if (plan === null) {
        // Either it expired or it never existed. Both mean the same thing to a tester — the preview
        // they approved is no longer the one this gateway would run — and re-planning is the answer
        // to both.
        throw invalid(
          'no plan is being held under that id; compose a new one',
          'planId',
          'the plan has expired or was never composed',
        );
      }
      if (plan.sessionId !== parsed.data.sessionId) {
        throw invalid(
          'that plan belongs to another session',
          'planId',
          'plan and session do not match',
        );
      }

      const loaded = await database.withTenant('seed-schemas', (db) =>
        loadEntitySchemas(db, scope.memoryVersionId),
      );
      const schemasById = new Map(loaded.schemas.map((schema) => [schema.id, schema]));

      const materializers: Materializer[] = [
        createUiMaterializer({
          dispatcher,
          schemas: schemasById,
          deleteFlows: loaded.deleteFlows,
        }),
      ];

      const outcome = await runChain(plan, {
        materializers,
        schemas: schemasById,
        tenantId,
        sessionId: scope.sessionId,
        applicationId: scope.applicationId,
        memoryVersionId: scope.memoryVersionId,
        nodeDeadlineMs: config.SEED_MATERIALIZE_TIMEOUT_MS,
        now: new Date(),
      });

      // Released whatever happened. A plan that has been run once must not be approvable again:
      // the failed half of a partial run is re-planned, not replayed, because replaying would
      // re-create the nodes that did succeed.
      await plans.release(tenantId, parsed.data.planId);

      const ledger = await database.withTenant('seed-ledger', async (db) => {
        const entries: SeedLedgerEntry[] = [];
        for (const created of outcome.records) {
          entries.push(
            await insertLedgerEntry(db, {
              tenantId,
              sessionId: scope.sessionId,
              planId: plan.id,
              nodeId: created.node.nodeId,
              entitySchemaId: created.node.entitySchemaId,
              entity: created.node.entity,
              externalRef: created.record.externalRef,
              adapterUsed: created.adapter,
              payload: created.record.payload,
              provenance: created.node.provenance,
              inverseOp: created.record.inverseOp,
            }),
          );
        }

        await recordAudit(db, {
          tenantId,
          actor: userId,
          action: 'seed-execute',
          target: scope.applicationId,
          metadata: {
            sessionId: scope.sessionId,
            planId: plan.id,
            approvedAt: parsed.data.approvedAt,
            outcome: outcome.result.outcome,
            adapter: outcome.result.adapterUsed,
            // Entity names and counts. Never the composed values — those are the customer's data,
            // and an audit log is one of the sinks CLAUDE.md's PII rule is about.
            entities: outcome.records.map((record) => record.node.entity),
          },
        });

        return entries;
      });

      for (const attempt of outcome.result.attempts) {
        metrics.seedMaterializeTotal.add(1, { adapter: attempt.adapter, outcome: attempt.outcome });
      }

      const response: SeedExecuteResponse = { result: outcome.result, ledger };
      return await reply.code(outcome.result.outcome === 'created' ? 201 : 200).send(response);
    },
  );

  app.post('/v1/seed/revert', { config: { permission: 'seed:revert' } }, async (request, reply) => {
    const { tenantId, userId } = principalOf(request);

    const parsed = SeedRevertRequest.safeParse(request.body);
    if (!parsed.success) {
      throw new GatewayError('validation_failed', 'invalid seed revert request', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || 'root',
          message: issue.message,
        })),
      });
    }

    const startedAt = Date.now();

    const entries = await database.withTenant('seed-revert-load', async (db) => {
      if (parsed.data.scope === 'entry') {
        const entry = await findLedgerEntry(db, parsed.data.ledgerEntryId);
        if (entry === null) {
          throw invalid('unknown ledger entry for this tenant', 'ledgerEntryId', 'unknown entry');
        }
        return [entry];
      }
      return listOutstandingForSession(db, parsed.data.sessionId);
    });

    const sessionId =
      parsed.data.scope === 'session' ? parsed.data.sessionId : entries[0]?.sessionId;
    if (sessionId === undefined) {
      const empty: SeedRevertResponse = { outcomes: [], durationMs: Date.now() - startedAt };
      return await reply.code(200).send(empty);
    }

    const scope = await scopeFor(tenantId, userId, sessionId, null, 'seed-revert');

    const loaded = await database.withTenant('seed-schemas', (db) =>
      loadEntitySchemas(db, scope.memoryVersionId),
    );
    const ui = createUiMaterializer({
      dispatcher,
      schemas: new Map(loaded.schemas.map((schema) => [schema.id, schema])),
      deleteFlows: loaded.deleteFlows,
    });

    const outcomes: SeedRevertOutcome[] = [];
    for (const entry of entries) {
      outcomes.push(
        await revertOne(entry, {
          ui,
          tenantId,
          applicationId: scope.applicationId,
          memoryVersionId: scope.memoryVersionId,
          deadlineMs: config.SEED_MATERIALIZE_TIMEOUT_MS,
          database,
        }),
      );
    }

    await database.withTenant('seed-revert-audit', (db) =>
      recordAudit(db, {
        tenantId,
        actor: userId,
        action: 'seed-revert',
        target: scope.applicationId,
        metadata: {
          sessionId,
          scope: parsed.data.scope,
          outcomes: outcomes.map((outcome) => outcome.outcome),
        },
      }),
    );

    const response: SeedRevertResponse = { outcomes, durationMs: Date.now() - startedAt };
    return await reply.code(200).send(response);
  });
}

interface RevertDependencies {
  readonly ui: Materializer;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly memoryVersionId: string;
  readonly deadlineMs: number;
  readonly database: TenantDatabase;
}

/**
 * Undo one ledger entry.
 *
 * The ledger is stamped *after* the adapter reports success, never before. An entry marked
 * reverted whose record is still in the application is the worse of the two failure modes: the
 * tester is told their staging data is clean, the row is still there, and nothing will ever look
 * at it again.
 */
async function revertOne(
  entry: SeedLedgerEntry,
  deps: RevertDependencies,
): Promise<SeedRevertOutcome> {
  const identity = {
    ledgerEntryId: entry.id,
    entity: entry.entity,
    externalRef: entry.externalRef,
  };

  if (entry.revertedAt !== null) {
    return {
      ...identity,
      outcome: 'already_reverted',
      reason: `it was reverted at ${entry.revertedAt}`,
    };
  }

  if (entry.inverseOp.kind === 'none') {
    return { ...identity, outcome: 'not_revertible', reason: entry.inverseOp.reason };
  }

  const failure = await deps.ui.revert(entry.inverseOp, {
    tenantId: deps.tenantId,
    applicationId: deps.applicationId,
    memoryVersionId: deps.memoryVersionId,
    entity: entry.entity,
    externalRef: entry.externalRef,
    detailPath: detailPathOf(entry.payload),
    deadlineMs: deps.deadlineMs,
  });

  if (failure !== null) {
    return { ...identity, outcome: 'failed', reason: failure.reason };
  }

  const stamped = await deps.database.withTenant('seed-revert-stamp', (db) =>
    markReverted(db, entry.id),
  );

  return stamped
    ? { ...identity, outcome: 'reverted', reason: null }
    : {
        ...identity,
        outcome: 'already_reverted',
        reason: 'another revert stamped this entry while this one was running',
      };
}

/** The record's own path, as the adapter stored it on the ledger payload. */
function detailPathOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const path = (payload as { detailPath?: unknown }).detailPath;
  return typeof path === 'string' ? path : null;
}

/**
 * What the preview card renders: per node, which adapter will run and whether it can be undone.
 *
 * Computed from the same descriptor ordering the chain will use, so the preview is a promise
 * rather than a guess. § 4 forbids silent degradation, and a preview that said "api" while the
 * chain then ran the UI adapter would be exactly that, in the one place the tester is looking.
 */
function previewFor(
  plan: CompositionPlan,
  schemas: readonly EntitySchema[],
  deleteFlows: ReadonlyMap<string, string>,
): SeedNodePreview[] {
  const now = new Date();

  return plan.materializationOrder.flatMap((nodeId): SeedNodePreview[] => {
    const node = plan.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (node === undefined) return [];

    if (node.mode === 'reuse_existing') {
      return [
        {
          nodeId: node.nodeId,
          entity: node.entity,
          mode: 'reuse_existing' as const,
          adapter: null,
          adapterReason:
            `${node.entity} ${node.existingExternalRef ?? ''} already exists and will be reused`.trim(),
          revert: {
            revertible: false,
            kind: 'none' as const,
            detail: 'nothing is created for a reused record, so there is nothing to undo',
          },
        },
      ];
    }

    const schema = schemas.find((candidate) => candidate.id === node.entitySchemaId);
    const descriptors = orderDescriptors(schema?.materializers ?? [], now);
    const chosen = descriptors[0];
    const flow = deleteFlows.get(node.entity);

    return [
      {
        nodeId: node.nodeId,
        entity: node.entity,
        mode: 'create' as const,
        // No materializer at all is not previewable as a create. It is reported as `ui` with the
        // reason, because the chain will fail on this node and the preview's job is to say so
        // before a tester approves it rather than after.
        adapter: chosen?.spec.kind ?? 'ui',
        adapterReason:
          chosen === undefined
            ? `${node.entity} has no materializer — nothing in this application creates one`
            : reasonFor(chosen.spec.kind, descriptors.length),
        revert:
          flow === undefined
            ? {
                revertible: false,
                kind: 'none' as const,
                detail: `no delete control for ${node.entity} was found when this application was indexed, so this record will remain`,
              }
            : {
                revertible: true,
                kind: 'ui' as const,
                detail: `the indexed delete flow ${flow} will remove it`,
              },
      },
    ];
  });
}

function reasonFor(kind: string, available: number): string {
  if (available === 1) return `the ${kind} materializer is the only one this application has`;
  return `the ${kind} materializer is first in the fallback chain for this entity`;
}
