/**
 * Navigation rate limiting.
 *
 * ARCHITECTURE § 5: "Crawl is bounded by an allowlist, a depth cap, and a rate limit." The first
 * two stop the crawler going somewhere it should not; this one stops it going everywhere at once.
 * An indexer without it is a load test the customer did not ask for, aimed at a staging
 * environment that is usually a fraction of production's size.
 *
 * Deliberately a minimum interval between navigations rather than a token bucket. A bucket would
 * permit a burst of `requestsPerMinute` navigations in the first second, which is exactly the
 * shape that trips a rate limiter on the other side and gets the crawler blocked. Spacing them
 * evenly produces the same throughput and never looks like an attack.
 */

export interface RateLimiter {
  /** Resolve when the next navigation may proceed. */
  acquire(): Promise<void>;
}

export interface RateLimiterClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const systemClock: RateLimiterClock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

export function createRateLimiter(
  requestsPerMinute: number,
  clock: RateLimiterClock = systemClock,
): RateLimiter {
  const minimumIntervalMs = 60_000 / requestsPerMinute;
  // Serialised through a promise chain so concurrent callers queue rather than all reading the
  // same `last` and all deciding they may go now.
  let queue: Promise<void> = Promise.resolve();
  let last = Number.NEGATIVE_INFINITY;

  return {
    acquire(): Promise<void> {
      queue = queue.then(async () => {
        const wait = last + minimumIntervalMs - clock.now();
        if (wait > 0) await clock.sleep(wait);
        last = clock.now();
      });
      return queue;
    },
  };
}
