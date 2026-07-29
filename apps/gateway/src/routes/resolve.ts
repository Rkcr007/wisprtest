import type { FastifyInstance } from 'fastify';
import { EscalateRequest } from 'protocol';

import type { GatewayConfig } from '../config.js';
import { GatewayError } from '../errors.js';
import { runEscalation, type ModelProvider } from '../model/index.js';
import type { GatewayMetrics } from '../telemetry/metrics.js';

/**
 * `POST /v1/resolve/escalate` — Tier 2, the only tier that leaves the device.
 *
 * The extension reaches this route for under 5% of commands: only when T0 (alias) and T1
 * (embedding) both fell below threshold (CLAUDE.md § "Resolution tiers"). It hands over the
 * scoped candidate set — dozens of elements, already redacted — and asks a small fast model which
 * one the phrase names. Everything that makes this safe and bounded lives in the escalation
 * service: redaction before the prompt, an 800 ms hard budget, one repair retry, a configured
 * fallback, and a refusal to return anything the contract has not validated. This route is the
 * thin HTTP skin over it: validate in, record the tier, map the typed failures to status codes.
 *
 * ## Why the failures are typed rather than a 500
 *
 * A slow or unusable model must not hang the tester. On timeout the service throws
 * `resolution_timeout` (504, retryable); when the model answered but produced no usable pick it
 * throws `resolution_not_found` (404). Both are things the extension already knows how to handle —
 * it falls back to disambiguation with the T1 candidates it holds — so the worst case at T2 is a
 * tester picking from a list, never a wrong click.
 */

export interface ResolveRoutesOptions {
  readonly config: GatewayConfig;
  readonly metrics: GatewayMetrics;
  /** The T2 model. Real Anthropic in production; a fake in tests, so the suite needs no network. */
  readonly modelProvider: ModelProvider;
}

/** The failure codes this route produces, mapped to the metric `outcome` label. */
const OUTCOME_BY_CODE: Record<string, string> = {
  resolution_timeout: 'timeout',
  resolution_not_found: 'not_found',
};

export function registerResolveRoutes(app: FastifyInstance, options: ResolveRoutesOptions): void {
  const { config, metrics, modelProvider } = options;

  app.post(
    '/v1/resolve/escalate',
    { config: { permission: 'resolve:escalate' } },
    async (request, reply) => {
      const tenantId = request.principal?.tenantId;
      if (tenantId === undefined) {
        // Unreachable: the route requires authentication. Checked rather than asserted because a
        // model call made without a tenant in context is a model call billed to the wrong one.
        throw new GatewayError('unauthorized', 'authentication required');
      }

      const parsed = EscalateRequest.safeParse(request.body);
      if (!parsed.success) {
        throw new GatewayError('validation_failed', 'invalid escalation request', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'root',
            message: issue.message,
          })),
        });
      }

      const startedAt = performance.now();
      try {
        const outcome = await runEscalation(parsed.data, {
          provider: modelProvider,
          primaryModel: config.MODEL_PRIMARY,
          fallbackModel: config.MODEL_FALLBACK,
          budgetMs: config.MODEL_TIMEOUT_MS,
        });

        // Every T2 resolution is one data point in the tier distribution — the health metric for
        // the compounding loop. A healthy product sees this share fall over time as write-backs
        // move phrasings down to T0.
        metrics.tierTotal.add(1, { tier: 'T2', outcome: 'resolved' });
        metrics.resolutionLatencyMs.record(outcome.elapsedMs, { tier: 'T2', outcome: 'resolved' });

        // Awaited inside the try: an un-awaited send would settle after this frame, and a failure
        // in it would miss the catch that records the outcome.
        return await reply.code(200).send(outcome.response);
      } catch (error: unknown) {
        if (error instanceof GatewayError && error.code in OUTCOME_BY_CODE) {
          const outcome = OUTCOME_BY_CODE[error.code];
          metrics.tierTotal.add(1, { tier: 'T2', outcome });
          metrics.resolutionLatencyMs.record(performance.now() - startedAt, {
            tier: 'T2',
            outcome,
          });
        }
        // Re-thrown to the single error handler, which owns the status mapping and the log line.
        throw error;
      }
    },
  );
}
