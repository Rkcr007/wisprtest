import { describe, expect, it } from 'vitest';

import { createRateLimiter, type RateLimiterClock } from './rate-limiter.js';

/** A clock the test drives, so the assertions are about spacing rather than about wall time. */
function fakeClock(): RateLimiterClock & { readonly sleeps: number[] } {
  const sleeps: number[] = [];
  let now = 0;

  return {
    sleeps,
    now: () => now,
    sleep: (ms: number) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

describe('createRateLimiter', () => {
  it('lets the first navigation through immediately', async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter(60, clock);

    await limiter.acquire();
    expect(clock.sleeps).toEqual([]);
  });

  it('spaces navigations evenly rather than allowing a burst', async () => {
    // A token bucket would let sixty navigations leave in the first second, which is the shape
    // that trips a rate limiter on the other side and gets the crawler blocked.
    const clock = fakeClock();
    const limiter = createRateLimiter(60, clock);

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    expect(clock.sleeps).toEqual([1000, 1000]);
  });

  it('serialises concurrent callers instead of letting them all read the same clock', async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter(120, clock);

    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);

    expect(clock.sleeps).toEqual([500, 500]);
  });

  it('does not wait when enough time has already passed', async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter(60, clock);

    await limiter.acquire();
    await clock.sleep(5_000);
    clock.sleeps.length = 0;
    await limiter.acquire();

    expect(clock.sleeps).toEqual([]);
  });
});
