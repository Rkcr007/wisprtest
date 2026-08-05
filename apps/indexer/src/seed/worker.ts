import type { Logger } from 'pino';
import type { SeedJob, SeedJobResult } from 'protocol';

import { isPoisoned, type JobStream } from '../redis/job-stream.js';
import type { SeedResultChannel } from '../redis/seed-results.js';
import { materializeOverHttp } from './http.js';
import { materialize, type MaterializerDependencies } from './materializer.js';

/**
 * The seed consume loop, alongside the crawl one.
 *
 * Structurally the same as `worker.ts` — one job at a time, acknowledge on a terminal state, drop
 * a message that cannot be parsed — with one deliberate difference: **a seed job is acknowledged
 * even when it fails.**
 *
 * A crawl that dies mid-run leaves its entry pending so another worker resumes it, because the
 * work is idempotent: re-crawling a route rewrites the same memory. A seed job is not. It fills a
 * form and submits it, and a job replayed after a worker died between the submit and the
 * acknowledgement would create the record a second time — one approval, two rows in the customer's
 * database, one of them absent from the ledger and therefore unrevertible.
 *
 * Losing a seed is recoverable and visible: the gateway's wait expires, the tester is told the
 * materialization did not complete, and they can ask again. A duplicate is neither. So the loop
 * gives up the at-least-once guarantee that makes crawling resumable, on purpose.
 *
 * The gateway is waiting on a result for every job here, so the failure path always publishes one
 * rather than letting the request time out — a tester learning *why* their seed failed is the
 * difference between re-indexing and filing a bug.
 */

export interface SeedWorkerOptions {
  readonly stream: JobStream<SeedJob>;
  readonly results: SeedResultChannel;
  readonly materializer: MaterializerDependencies;
  readonly logger: Logger;
  /** How long an uncollected result survives before Redis reclaims it. */
  readonly resultTtlSeconds: number;
}

export interface SeedWorker {
  run(): Promise<void>;
  stop(): void;
  isBusy(): boolean;
}

export function createSeedWorker(options: SeedWorkerOptions): SeedWorker {
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
      options.logger.info({ event: 'seed_worker.listening' }, 'waiting for seed jobs');

      while (!stopping()) {
        let delivery;
        try {
          delivery = await options.stream.next();
        } catch (error: unknown) {
          if (stopping()) break;
          options.logger.error(
            { event: 'seed_worker.read_failed', err: error },
            'seed job read failed',
          );
          await sleep(1_000);
          continue;
        }

        if (delivery === null) continue;

        if (isPoisoned(delivery)) {
          options.logger.error(
            {
              event: 'seed_worker.job_invalid',
              message_id: delivery.messageId,
              issues: delivery.issues,
            },
            'discarding a job that does not match the SeedJob contract',
          );
          await options.stream.ack(delivery.messageId);
          continue;
        }

        const { job } = delivery;
        busy = true;
        try {
          const result = await run(job, options.materializer);

          options.logger.info(
            {
              event: 'seed_worker.job_finished',
              tenant_id: job.tenantId,
              job_id: job.jobId,
              operation: job.operation,
              outcome: result.outcome,
              duration_ms: Math.round(result.durationMs),
              // The reason is a description of the *form*, never of a value that went into it —
              // `materializer.ts` builds it from field names and routes only.
              reason: result.failureReason,
            },
            'seed job finished',
          );

          await options.results.publish(result, options.resultTtlSeconds);
        } catch (error: unknown) {
          // `materialize` catches its own failures, so reaching here means the result could not be
          // *delivered*. Nothing else can be done for the waiting request; log it and move on
          // rather than replaying a job that may already have created a record.
          options.logger.error(
            { event: 'seed_worker.result_undeliverable', job_id: job.jobId, err: error },
            'could not return the seed result to the gateway',
          );
        } finally {
          await options.stream.ack(delivery.messageId);
          busy = false;
        }
      }

      options.logger.info({ event: 'seed_worker.stopped' }, 'seed job loop wound down');
    },
  };
}

/**
 * Route a job to the adapter that runs it.
 *
 * Both adapters take the same dependencies and answer the same contract, so the split is only
 * about *how* the write is made: a browser driving a form, or a request issued from inside that
 * browser's session. Which one a job gets was decided by the gateway's fallback chain long before
 * it reached this stream.
 */
async function run(job: SeedJob, deps: MaterializerDependencies): Promise<SeedJobResult> {
  return job.operation === 'ui_create' || job.operation === 'ui_revert'
    ? await materialize(job, deps)
    : await materializeOverHttp(job, deps);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
