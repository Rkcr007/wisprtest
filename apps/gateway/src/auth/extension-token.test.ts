import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';
import {
  isExtensionBearer,
  mintExtensionToken,
  originOf,
  scopesForRole,
  verifyExtensionToken,
} from './extension-token.js';

const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  GATEWAY_HOST: '127.0.0.1',
  GATEWAY_PORT: '8080',
  DATABASE_URL: 'postgres://wispr:secret@localhost:5432/wispr?sslmode=disable',
  REDIS_URL: 'redis://localhost:6379',
  QDRANT_URL: 'http://localhost:6333',
  DB_POOL_MAX: '10',
  OIDC_ISSUER_URL: 'https://idp.example/realms/wispr',
  OIDC_AUDIENCE: 'wispr-gateway',
  OIDC_CLOCK_TOLERANCE_SECONDS: '60',
  EXTENSION_TOKEN_SIGNING_KEY: 'test-extension-token-signing-key-32b',
  EXTENSION_TOKEN_TTL_SECONDS: '900',
  RATE_LIMIT_MAX: '600',
  RATE_LIMIT_WINDOW_MS: '60000',
  MODEL_API_KEY: 'sk-ant-test',
  MODEL_BASE_URL: 'https://api.anthropic.com',
  MODEL_PRIMARY: 'claude-haiku-4-5-20251001',
  MODEL_FALLBACK: 'claude-haiku-4-5-20251001',
  MODEL_TIMEOUT_MS: '800',
  INDEXER_JOB_STREAM: 'indexer:jobs',
  SEED_JOB_STREAM: 'indexer:seed',
  DRIFT_JOB_STREAM: 'indexer:drift',
  DRIFT_RECONCILE_TIMEOUT_MS: '120000',
  COMPOSER_URL: 'http://127.0.0.1:8090',
  COMPOSER_TIMEOUT_MS: '1200',
  SEED_PLAN_TTL_SECONDS: '300',
  SEED_MATERIALIZE_TIMEOUT_MS: '60000',
  EVIDENCE_ENDPOINT: 'http://localhost:9000',
  EVIDENCE_BUCKET: 'wispr-evidence',
  EVIDENCE_REGION: 'us-east-1',
  EVIDENCE_ACCESS_KEY_ID: 'wispr-local-dev',
  EVIDENCE_SECRET_ACCESS_KEY: 'wispr-local-dev-secret',
  EVIDENCE_URL_TTL_SECONDS: '300',
  OTEL_SERVICE_NAME: 'wispr-gateway',
  SHUTDOWN_TIMEOUT_MS: '10000',
});

describe('originOf', () => {
  it('drops the path so /login and /orders are the same application', () => {
    expect(originOf('https://orders.northwind.example/login')).toBe(
      'https://orders.northwind.example',
    );
  });

  it('refuses anything that is not http(s)', () => {
    expect(originOf('file:///tmp/x')).toBeNull();
    expect(originOf('not a url')).toBeNull();
  });
});

describe('scopesForRole', () => {
  it('gives a lead seed execute, which a tester does not hold', () => {
    expect(scopesForRole('lead')).toContain('memory:read');
    expect(scopesForRole('lead')).toContain('seed:execute');
  });

  it('gives a tester session write and not seed execute', () => {
    expect(scopesForRole('tester')).toContain('session:write');
    expect(scopesForRole('tester')).not.toContain('seed:execute');
  });
});

describe('mint and verify', () => {
  it('round-trips a scoped token the contract will accept', async () => {
    const minted = await mintExtensionToken(
      {
        email: 'daniel.tester@northwind.example',
        userId: '22222222-2222-4222-8222-222222222222',
        tenantId: '11111111-1111-4111-8111-111111111111',
        applicationId: '33333333-3333-4333-8333-333333333331',
        scopes: scopesForRole('tester'),
      },
      config,
    );

    expect(minted.tokenType).toBe('Bearer');
    expect(isExtensionBearer(minted.token)).toBe(true);

    const claims = await verifyExtensionToken(minted.token, config);
    expect(claims.email).toBe('daniel.tester@northwind.example');
    expect(claims.applicationId).toBe('33333333-3333-4333-8333-333333333331');
    expect(claims.scopes).toEqual(scopesForRole('tester'));
  });

  it('rejects a token signed with a different key', async () => {
    const minted = await mintExtensionToken(
      {
        email: 'daniel.tester@northwind.example',
        userId: '22222222-2222-4222-8222-222222222222',
        tenantId: '11111111-1111-4111-8111-111111111111',
        applicationId: null,
        scopes: ['memory:read'],
      },
      config,
    );

    await expect(
      verifyExtensionToken(minted.token, {
        ...config,
        EXTENSION_TOKEN_SIGNING_KEY: 'a-different-extension-token-key-32b',
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
