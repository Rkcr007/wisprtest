import type { Logger } from 'pino';
import type { DriftReconcileJob } from 'protocol';

import { isPoisoned, type JobStream } from '../redis/job-stream.js';
import type { IndexerMetrics } from '../telemetry/metrics.js';
import { reconcile, type ReconcileDependencies } from './reconcile.js';

/**
 * The reconcile consume loop, alongside the crawl and seed ones.
 *
 * Structurally the same as `seed/worker.ts` — one job at a time, drop a message that cannot be
 * parsed — with the acknowledgement rule inverted, and that inversion is the whole design.
 *
 * ## A failed reconcile is retried; a failed seed is not
 *
 * A seed job is acknowledged even when it fails, because replaying one could create a second
 * record in the customer's database against a single approval. A reconcile writes a candidate
 * memory version and *nothing in the customer's application*: replaying it builds another
 * candidate, supersedes the first, and costs a browser session. So the guarantee the seed loop
 * gives up on purpose is worth keeping here — the entry stays pending and another worker reclaims
 * it once it has been idle long enough.
 *
 * ## But only once
 *
 * Retrying forever is the failure mode that rule invites: a route that 404s for a structural
 * reason fails identically on every attempt, and an unacknowledged entry is redelivered until
 * somebody notices. `DeliveredJob.reclaimed` says whether this delivery is already a second
 * attempt, so a job that fails twice is acknowledged and given up on. The report goes back to
 * `open` either way — the drift is still real, and it stays in the queue a human reads.
 */

export interface DriftWorkerOptions {
  readonly stream: JobStream<DriftReconcileJob>;
  readonly reconciler: ReconcileDependencies;
  readonly metrics: IndexerMetrics;
  readonly logger: Logger;
}

export interface DriftWorker {
  run(): Promise<void>;
  stop(): void;
  isBusy(): boolean;
}

export function createDriftWorker(options: DriftWorkerOptions): DriftWorker {
  const controller = new AbortController();
  const stopping = (): boolean => controller.signal.aborted;
  let busy = false;

  return {
    isBusy: () => busy,

    stop(): void {
      controller.abort();
    },

    async run(): Promise<void> {
      await options.stream.ensureGroup();
      options.logger.info({ event: 'drift_worker.listening' }, 'waiting for reconcile jobs');

      while (!stopping()) {
        let delivery;
        try {
          delivery = await options.stream.next();
        } catch (error: unknown) {
          if (stopping()) break;
          options.logger.error(
            { event: 'drift_worker.read_failed', err: error },
            'reconcile job read failed',
          );
          await sleep(1_000);
          continue;
        }

        if (delivery === null) continue;

        if (isPoisoned(delivery)) {
          options.logger.error(
            {
              event: 'drift_worker.job_invalid',
              message_id: delivery.messageId,
              issues: delivery.issues,
            },
            'discarding a job that does not match the DriftReconcileJob contract',
          );
          await options.stream.ack(delivery.messageId);
          continue;
        }

        const { job, reclaimed } = delivery;
        busy = true;
        try {
          const result = await reconcile(job, options.reconciler);

          options.metrics.driftReconcilesTotal.add(1, { outcome: result.outcome });
          options.metrics.driftReconcileDurationMs.record(result.durationMs, {
            outcome: result.outcome,
          });
          if (result.aliasMigrationRate !== null) {
            options.metrics.driftAliasMigrationRate.record(result.aliasMigrationRate);
          }

          options.logger.info(
            {
              event: 'drift_worker.job_finished',
              tenant_id: job.tenantId,
              job_id: job.jobId,
              drift_report_id: job.driftReportId,
              outcome: result.outcome,
              duration_ms: Math.round(result.durationMs),
              candidate_memory_version_id: result.candidateMemoryVersionId,
              alias_migration_rate: result.aliasMigrationRate,
              // Counts, never the elements themselves: an accessible name is the customer's text
              // and CLAUDE.md § "Conventions" forbids it reaching a log sink.
              added: result.diff?.added.length ?? null,
              removed: result.diff?.removed.length ?? null,
              moved: result.diff?.moved.length ?? null,
              renamed: result.diff?.renamed.length ?? null,
              reason: result.reason,
              retry: reclaimed,
            },
            'reconcile finished',
          );

          if (result.outcome === 'failed' && !reclaimed) {
            // Leave it pending. Another worker — or this one — reclaims it after the configured
            // idle window and tries once more.
            continue;
          }
        } catch (error: unknown) {
          // `reconcile` handles its own failures, so reaching here is a bug or a database that
          // went away mid-write. Same rule: one retry, then give up rather than loop.
          options.logger.error(
            {
              event: 'drift_worker.job_threw',
              job_id: job.jobId,
              drift_report_id: job.driftReportId,
              retry: reclaimed,
              err: error,
            },
            'reconcile threw',
          );
          options.metrics.driftReconcilesTotal.add(1, { outcome: 'failed' });
          if (!reclaimed) continue;
        } finally {
          busy = false;
        }

        await options.stream.ack(delivery.messageId);
      }

      options.logger.info({ event: 'drift_worker.stopped' }, 'reconcile loop wound down');
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
