import type { Redis } from 'ioredis';
import type { CrawlJob } from 'protocol';
import type { Logger } from 'pino';
import type { Browser } from 'playwright';

import { runJob, type JobRunnerDependencies } from './job-runner.js';
import { isPoisoned, type JobStream } from './redis/job-stream.js';
import type { TenantDatabase } from './db/pool.js';
import type { SecretResolver } from './crawl/secrets.js';
import type { IndexerMetrics } from './telemetry/metrics.js';

/**
 * The consume loop: one job at a time, forever, until told to stop.
 *
 * One at a time on purpose. A crawl is browser-bound, not IO-bound — two concurrent jobs in one
 * process contend for the same CPU and make both slower while doubling the memory. Concurrency is
 * a replica count, which is also what makes it a deployment decision rather than a config
 * variable somebody has to tune per customer.
 *
 * ## What is acknowledged, and when
 *
 * A job is acknowledged when it reaches a terminal state — completed or failed. A cancelled job
 * is *not* acknowledged: the entry stays pending, and once it has been idle for
 * `INDEXER_CLAIM_MIN_IDLE_MS` another worker reclaims it and resumes the crawl from its
 * checkpoint. That single decision is the whole of "a crashed job restarts from the last
 * completed route".
 *
 * A message that does not parse as a `CrawlJob` is acknowledged and logged. It cannot be executed
 * by this worker or any other, so leaving it pending would only mean every worker reclaims it in
 * turn, forever, ahead of the work that can actually run.
 */

export interface WorkerOptions {
  readonly stream: JobStream<CrawlJob>;
  readonly database: TenantDatabase;
  readonly redis: Redis;
  readonly browser: Browser;
  readonly secrets: SecretResolver;
  readonly metrics: IndexerMetrics;
  readonly logger: Logger;
  readonly progressMaxLength: number;
  readonly addressLookup?: JobRunnerDependencies['addressLookup'];
}

export interface Worker {
  /** Consume until `stop()` is called. Resolves once the loop has wound down. */
  run(): Promise<void>;
  /** Ask the loop to finish: the current job is cancelled between routes, not interrupted. */
  stop(): void;
  /** Whether a job is in flight. Reported by the health endpoint. */
  isBusy(): boolean;
}

export function createWorker(options: WorkerOptions): Worker {
  // One signal for both jobs: it stops the loop and cancels the crawl in flight. A separate
  // boolean would be a second source of truth about the same fact.
  const controller = new AbortController();
  // Read through a function rather than inline: the signal is set from outside the loop, and
  // type-aware analysis of `while (!controller.signal.aborted)` otherwise narrows every later
  // read of it to `false` — which is exactly the case this code exists to handle.
  const stopping = (): boolean => controller.signal.aborted;
  let busy = false;

  return {
    isBusy: () => busy,

    stop(): void {
      controller.abort();
    },

    async run(): Promise<void> {
      await options.stream.ensureGroup();
      options.logger.info({ event: 'worker.listening' }, 'waiting for crawl jobs');

      while (!stopping()) {
        let delivery;
        try {
          delivery = await options.stream.next();
        } catch (error: unknown) {
          if (stopping()) break;
          // A Redis blip should not end the worker. Sleep briefly so a persistent failure does not
          // become a hot loop against a server that is already unwell.
          options.logger.error({ event: 'worker.read_failed', err: error }, 'job read failed');
          await sleep(1_000);
          continue;
        }

        if (delivery === null) continue;

        if (isPoisoned(delivery)) {
          options.logger.error(
            {
              event: 'worker.job_invalid',
              message_id: delivery.messageId,
              issues: delivery.issues,
            },
            'discarding a job that does not match the CrawlJob contract',
          );
          await options.stream.ack(delivery.messageId);
          continue;
        }

        busy = true;
        try {
          const outcome = await runJob(
            delivery.job,
            {
              database: options.database,
              redis: options.redis,
              browser: options.browser,
              secrets: options.secrets,
              metrics: options.metrics,
              logger: options.logger,
              progressMaxLength: options.progressMaxLength,
              ...(options.addressLookup === undefined
                ? {}
                : { addressLookup: options.addressLookup }),
            },
            controller.signal,
          );

          if (outcome.status === 'cancelled') {
            options.logger.info(
              { event: 'worker.job_requeued', message_id: delivery.messageId },
              'leaving the job pending for another worker to reclaim',
            );
          } else {
            await options.stream.ack(delivery.messageId);
          }
        } finally {
          busy = false;
        }
      }

      options.logger.info({ event: 'worker.stopped' }, 'job loop wound down');
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
