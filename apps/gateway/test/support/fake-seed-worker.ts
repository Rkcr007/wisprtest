import { Redis } from 'ioredis';
import { UiSeedJob, type UiSeedResult } from 'protocol';

/**
 * A seed worker that answers over the real Redis, without a browser.
 *
 * The browser half is tested where it lives — `apps/indexer/test/e2e/seed.test.ts` drives a real
 * create form in a real Chromium against a real Express application, and asserts the record
 * exists by asking that application's own API. Repeating it here would be a slower copy of a test
 * that already passes.
 *
 * What this covers instead is the part that is genuinely the gateway's, and that a mock of the
 * dispatcher would skip entirely: the job is encoded, written to the stream the indexer reads,
 * validated against `UiSeedJob` on the way out, and the result comes back on the key the indexer
 * would write it to. That pairing is the thing most likely to be wrong — the two services derive
 * the namespace differently, and a mismatch fails silently on both sides.
 */

export interface FakeSeedWorker {
  /** Every job the gateway published, parsed against the contract. */
  readonly jobs: UiSeedJob[];
  /** Decide what to answer. Called per job; return null to answer nothing and force a timeout. */
  respondWith(handler: (job: UiSeedJob) => UiSeedResult | null): void;
  stop(): Promise<void>;
}

export interface FakeSeedWorkerOptions {
  /** Connection string, not the gateway's client — see below. */
  readonly redisUrl: string;
  /** The stream name as configured, relative to the `wispr:` namespace. */
  readonly stream: string;
}

/**
 * Consume the stream and answer.
 *
 * Reads with `XREAD` from the end of the stream rather than joining the indexer's consumer group:
 * this is a test double sitting beside a queue, not a second worker competing for its work, and a
 * group membership left behind would change how the next run's messages are delivered.
 */
export function startFakeSeedWorker(options: FakeSeedWorkerOptions): FakeSeedWorker {
  const jobs: UiSeedJob[] = [];
  let handler: (job: UiSeedJob) => UiSeedResult | null = () => null;
  let running = true;

  // Its own connection, with **no `keyPrefix`** — because that is how the indexer's client is
  // configured, and this double is standing in for the indexer. Duplicating the gateway's
  // prefixed client instead would have it answer on `wispr:wispr:seed:result:…` while the gateway
  // waits on `wispr:seed:result:…`, and both sides would sit there looking correct. That is the
  // exact failure this suite is here to catch, so the double must not be able to hide it.
  const reader = new Redis(options.redisUrl, { lazyConnect: false });

  const streamKey = `wispr:${options.stream}`;

  const loop = (async () => {
    let cursor = '$';
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `stop()` flips it
    while (running) {
      let response: unknown;
      try {
        response = await reader.xread('BLOCK', 200, 'STREAMS', streamKey, cursor);
      } catch {
        // The connection was closed by `stop()`, or Redis blipped. Either way the loop is over.
        return;
      }
      if (!Array.isArray(response)) continue;

      const [entry] = response as [[string, [string, string[]][]]];
      for (const [id, fields] of entry[1]) {
        cursor = id;
        const index = fields.indexOf('job');
        const raw = index === -1 ? undefined : fields[index + 1];
        if (raw === undefined) continue;

        const job = UiSeedJob.parse(JSON.parse(raw));
        jobs.push(job);

        const result = handler(job);
        if (result === null) continue;

        // The key the indexer writes to: namespaced in code on that side, which is what the
        // gateway's `keyPrefix` produces on this one.
        await reader.rpush(`wispr:seed:result:${job.jobId}`, JSON.stringify(result));
        await reader.expire(`wispr:seed:result:${job.jobId}`, 60);
      }
    }
  })();

  return {
    jobs,
    respondWith(next: (job: UiSeedJob) => UiSeedResult | null): void {
      handler = next;
    },
    async stop(): Promise<void> {
      running = false;
      reader.disconnect();
      await loop;
    },
  };
}

/** A successful create, as the indexer's materializer would report one. */
export function createdResult(job: UiSeedJob, externalRef: string): UiSeedResult {
  return {
    jobId: job.jobId,
    operation: 'create',
    outcome: 'succeeded',
    externalRef,
    detailPath: `/orders/${externalRef}`,
    failureReason: null,
    durationMs: 4200,
  };
}

/** A successful revert. */
export function revertedResult(job: UiSeedJob): UiSeedResult {
  return {
    jobId: job.jobId,
    operation: 'revert',
    outcome: 'succeeded',
    externalRef: null,
    detailPath: null,
    failureReason: null,
    durationMs: 2800,
  };
}

/** A failure, with the concrete reason the tester ends up reading. */
export function failedResult(job: UiSeedJob, reason: string): UiSeedResult {
  return {
    jobId: job.jobId,
    operation: job.operation,
    outcome: 'failed',
    externalRef: null,
    detailPath: null,
    failureReason: reason,
    durationMs: 5100,
  };
}
