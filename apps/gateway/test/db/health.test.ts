import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../support/harness.js';

/**
 * Liveness and readiness, against the real dependencies.
 *
 * The interesting assertions are the negative ones: readiness has to *fail* when a dependency
 * is unreachable, and it has to say which. A probe that only ever returns 200 in a test is a
 * probe nobody has tested.
 */

let harness: Harness;

interface ReadyBody {
  status: string;
  checks: { name: string; ok: boolean; durationMs: number; error?: string }[];
}

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  await harness.close();
});

describe('/healthz', () => {
  it('answers without a token', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('touches no dependency', async () => {
    // Liveness must not depend on anything external. If it did, a brief database blip would
    // make the orchestrator kill every replica — turning a recoverable dependency problem into
    // a full outage at the moment the dependency can least afford a reconnection storm. The
    // proxy for "touched nothing" is that it answers far faster than any network round trip.
    const started = performance.now();
    await harness.app.inject({ method: 'GET', url: '/healthz' });
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('/readyz', () => {
  it('reports every dependency by name when all three are up', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/readyz' });
    const body = response.json<ReadyBody>();

    expect(response.statusCode).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.checks.map((check) => check.name).sort()).toEqual(['postgres', 'qdrant', 'redis']);
    expect(body.checks.every((check) => check.ok)).toBe(true);
  });

  it('answers without a token, since a probe cannot authenticate', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
  });

  it('really checks postgres rather than reporting a constant', async () => {
    // Point the probe at a port nothing is listening on. A readiness check that cannot fail is
    // decoration; this is the assertion that it is wired to something real.
    const broken = await startHarness({
      config: { DATABASE_URL: 'postgres://wispr:wrong@127.0.0.1:59998/wispr?sslmode=disable' },
    });

    try {
      const response = await broken.app.inject({ method: 'GET', url: '/readyz' });
      const body = response.json<ReadyBody>();
      const postgres = body.checks.find((check) => check.name === 'postgres');

      // 503, not 200 with a sad body: a load balancer reads the status code.
      expect(response.statusCode).toBe(503);
      expect(body.status).toBe('not_ready');
      expect(postgres?.ok).toBe(false);
      expect(postgres?.error).toBeTruthy();

      // The other two are still reported as healthy, so the failure names one dependency
      // instead of sending whoever is on call to look at all three.
      expect(body.checks.find((check) => check.name === 'redis')?.ok).toBe(true);
      expect(body.checks.find((check) => check.name === 'qdrant')?.ok).toBe(true);
    } finally {
      await broken.close();
    }
  });

  it('really checks qdrant', async () => {
    const broken = await startHarness({ config: { QDRANT_URL: 'http://127.0.0.1:59997' } });

    try {
      const response = await broken.app.inject({ method: 'GET', url: '/readyz' });
      const body = response.json<ReadyBody>();

      expect(response.statusCode).toBe(503);
      expect(body.checks.find((check) => check.name === 'qdrant')?.ok).toBe(false);
      expect(body.checks.find((check) => check.name === 'postgres')?.ok).toBe(true);
    } finally {
      await broken.close();
    }
  });

  it('never leaks a connection string in the failure message', async () => {
    // Readiness is typically the one endpoint left unauthenticated, and a driver error can
    // carry the whole DSN — password included.
    const broken = await startHarness({
      config: {
        DATABASE_URL: 'postgres://wispr:sup3rs3cret@127.0.0.1:59998/wispr?sslmode=disable',
      },
    });

    try {
      const body = (await broken.app.inject({ method: 'GET', url: '/readyz' })).json<ReadyBody>();
      const serialised = JSON.stringify(body);

      expect(serialised).not.toContain('sup3rs3cret');
      expect(serialised).not.toContain('postgres://');
    } finally {
      await broken.close();
    }
  });

  it('bounds each check, so one hanging dependency does not hang the probe', async () => {
    // A dependency that accepts the connection and then never answers is the common failure,
    // and it is worse than one that refuses: without a timeout the probe hangs, the
    // orchestrator times out instead, and the reported reason is the probe rather than the
    // dependency. Port 59996 is a black hole — connect() will sit there.
    const hanging = await startHarness({ config: { QDRANT_URL: 'http://10.255.255.1:59996' } });

    try {
      const started = performance.now();
      const response = await hanging.app.inject({ method: 'GET', url: '/readyz' });
      const elapsed = performance.now() - started;

      expect(response.statusCode).toBe(503);
      // Comfortably above the 2 s probe timeout and well below anything that would look hung.
      expect(elapsed).toBeLessThan(8_000);
    } finally {
      await hanging.close();
    }
  });
});
