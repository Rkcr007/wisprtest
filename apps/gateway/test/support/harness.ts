import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';

import { createJwks } from '../../src/auth/jwks.js';
import { loadConfig, type GatewayConfig } from '../../src/config.js';
import { createTenantDatabase, type TenantDatabase } from '../../src/db/pool.js';
import { buildServer } from '../../src/http/server.js';
import { createLogger } from '../../src/logger.js';
import { createRedis } from '../../src/redis/client.js';
import { createMetrics } from '../../src/telemetry/metrics.js';
import { startFakeIssuer, type FakeIssuer } from './oidc.js';

/**
 * A gateway wired to the real compose stack.
 *
 * Real Postgres, real Redis, real Qdrant, and a real (in-process) OIDC issuer. The server is
 * built by the same `buildServer` that `main.ts` calls, with the same plugins and the same
 * error handler, so what the tests exercise is what runs — the only difference is `app.inject`
 * instead of a socket.
 */
export interface Harness {
  readonly app: FastifyInstance;
  readonly config: GatewayConfig;
  readonly issuer: FakeIssuer;
  readonly database: TenantDatabase;
  readonly redis: Redis;
  /** Log lines emitted during the test, for asserting on redaction and correlation fields. */
  readonly lines: () => Record<string, unknown>[];
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Overrides applied on top of the environment's config. */
  readonly config?: Partial<GatewayConfig>;
  /** Routes registered before the server is returned, so tests can exercise the pipeline. */
  readonly routes?: (app: FastifyInstance) => void;
  /**
   * Minimum interval between JWKS refetches triggered by an unknown `kid`.
   *
   * Production uses 30 s, which stops a flood of tokens bearing random `kid` values from being
   * turned into a denial-of-service attack against the identity provider. A rotation test
   * cannot observe a refetch through a 30-second cooldown, so it sets this to zero — and a
   * separate test restores a real cooldown to assert the protection is there.
   */
  readonly jwksCooldownMs?: number;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const issuer = await startFakeIssuer();

  const base = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    // Point the gateway at the fake issuer. `OIDC_JWKS_URI` is left unset on purpose so the
    // discovery path is exercised too — it is the one that runs in production.
    OIDC_ISSUER_URL: issuer.issuer,
    OIDC_AUDIENCE: 'wispr-gateway',
    OIDC_JWKS_URI: undefined,
  });

  const config: GatewayConfig = { ...base, ...options.config };

  const database = createTenantDatabase(config);
  const redis = createRedis(config);
  await redis.connect();

  const lines: Record<string, unknown>[] = [];
  // The real `createLogger`, not a bare pino instance. The redaction serialiser and the
  // context mixin live there, and a test that constructed its own logger would assert on a
  // pipeline the service does not use — which is exactly how a redaction rule ends up
  // protecting nothing.
  const logger = createLogger(
    { service: 'gateway', level: 'debug', env: 'test' },
    {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );

  const app = await buildServer({
    config,
    logger,
    database,
    redis,
    metrics: createMetrics(),
    jwks: createJwks(config, { cooldownMs: options.jwksCooldownMs ?? 0 }),
  });

  options.routes?.(app);
  await app.ready();

  return {
    app,
    config,
    issuer,
    database,
    redis,
    lines: () => lines,
    close: async () => {
      await app.close();
      await database.close();
      redis.disconnect();
      await issuer.close();
    },
  };
}

/** Ids from `db/seed/001_fixture.sql`, which `make db-reset` loads. */
export const SEED = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  leadEmail: 'priya.lead@northwind.example',
  testerEmail: 'daniel.tester@northwind.example',
  applicationId: '33333333-3333-4333-8333-333333333331',
  memoryVersionId: '44444444-4444-4444-8444-444444444441',
} as const;

/** From `db/seed/002_rls_neighbour.sql` — the tenant that must stay invisible. */
export const NEIGHBOUR = {
  tenantId: '99999999-9999-4999-8999-999999999999',
  ownerEmail: 'priya.lead@contoso.example',
  applicationId: '88888888-8888-4888-8888-888888888882',
} as const;
