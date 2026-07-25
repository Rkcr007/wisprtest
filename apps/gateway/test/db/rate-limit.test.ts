import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NEIGHBOUR, SEED, startHarness, type Harness } from '../support/harness.js';

/**
 * Rate limiting, against real Redis.
 *
 * Redis rather than an in-process counter because the budget has to hold across replicas: an
 * in-memory limiter with four pods gives every tenant four times its quota, and the number
 * changes silently whenever the deployment scales. That property is only testable against a
 * real store, which is why this suite lives here rather than in the unit tests.
 */

let harness: Harness;

const LIMIT = 5;

beforeAll(async () => {
  harness = await startHarness({
    config: { RATE_LIMIT_MAX: LIMIT, RATE_LIMIT_WINDOW_MS: 60_000 },
    routes: (app) => {
      app.get('/test/limited', () => ({ ok: true }));
    },
  });
});

afterAll(async () => {
  await harness.close();
});

/** Clear the limiter's keys so each test starts with a full budget. */
async function resetBudget(): Promise<void> {
  const keys = await harness.redis.keys('wispr:ratelimit:*');
  if (keys.length > 0) {
    // `keyPrefix` is applied by ioredis on write, so the keys returned by KEYS already carry it
    // and must be stripped before DEL, which would otherwise prefix them a second time.
    await harness.redis.del(...keys.map((key) => key.replace(/^wispr:/, '')));
  }
}

async function call(email: string) {
  const token = await harness.issuer.sign({ email });
  return harness.app.inject({
    method: 'GET',
    url: '/test/limited',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('per-tenant budgets', () => {
  it('serves up to the limit and then refuses', async () => {
    await resetBudget();

    for (let i = 0; i < LIMIT; i += 1) {
      expect((await call(SEED.leadEmail)).statusCode).toBe(200);
    }

    const refused = await call(SEED.leadEmail);
    expect(refused.statusCode).toBe(429);
  });

  it('shapes the refusal as a protocol error, not a bespoke one', async () => {
    await resetBudget();
    for (let i = 0; i < LIMIT; i += 1) await call(SEED.leadEmail);

    const refused = await call(SEED.leadEmail);
    // A client parses one error format whatever went wrong.
    expect(refused.json()).toMatchObject({
      code: 'rate_limited',
      message: 'too many requests',
      retryable: true,
    });
    expect(refused.json<{ retryAfterSeconds: number }>().retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.headers['retry-after']).toBeDefined();
  });

  it('counts a tenant, not a user', async () => {
    // Both accounts belong to Northwind, so they share one budget. Counting per user would let
    // a tenant multiply its quota by inviting more people.
    await resetBudget();

    for (let i = 0; i < LIMIT; i += 1) {
      expect((await call(SEED.leadEmail)).statusCode).toBe(200);
    }

    expect((await call(SEED.testerEmail)).statusCode).toBe(429);
  });

  it('does not let one tenant exhaust another’s budget', async () => {
    // The property that makes this a quota rather than a global throttle.
    await resetBudget();

    for (let i = 0; i < LIMIT + 2; i += 1) await call(SEED.leadEmail);
    expect((await call(SEED.leadEmail)).statusCode).toBe(429);

    expect((await call(NEIGHBOUR.ownerEmail)).statusCode).toBe(200);
  });

  it('keeps the count in Redis, so it holds across replicas', async () => {
    await resetBudget();
    await call(SEED.leadEmail);

    const keys = await harness.redis.keys('wispr:ratelimit:*');
    expect(keys.some((key) => key.includes(SEED.tenantId))).toBe(true);
  });
});

describe('probes are never throttled', () => {
  it('serves readiness however many times it is polled', async () => {
    await resetBudget();

    for (let i = 0; i < LIMIT * 3; i += 1) {
      const response = await harness.app.inject({ method: 'GET', url: '/healthz' });
      // A probe that can be rate limited will eventually mark a healthy service dead, which is
      // an outage the service inflicted on itself.
      expect(response.statusCode).toBe(200);
    }
  });
});
