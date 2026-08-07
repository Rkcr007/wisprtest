import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { ConfigError } from './errors.js';

const validEnv = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  INDEXER_WORKER_ID: 'indexer-local-1',
  INDEXER_HOST: '127.0.0.1',
  INDEXER_PORT: '8081',
  DATABASE_URL: 'postgres://wispr:wispr@localhost:5432/wispr?sslmode=disable',
  REDIS_URL: 'redis://localhost:6379',
  DB_POOL_MAX: '4',
  INDEXER_JOB_STREAM: 'wispr:indexer:jobs',
  INDEXER_CONSUMER_GROUP: 'indexers',
  INDEXER_BLOCK_MS: '2000',
  INDEXER_CLAIM_MIN_IDLE_MS: '60000',
  INDEXER_PROGRESS_MAXLEN: '10000',
  INDEXER_SEED_STREAM: 'wispr:indexer:seed',
  INDEXER_SEED_CONSUMER_GROUP: 'seeders',
  INDEXER_SEED_RESULT_TTL_SECONDS: '120',
  INDEXER_DRIFT_STREAM: 'wispr:indexer:drift',
  INDEXER_DRIFT_CONSUMER_GROUP: 'reconcilers',
  INDEXER_HEADLESS: 'true',
  OTEL_SERVICE_NAME: 'wispr-indexer',
  SHUTDOWN_TIMEOUT_MS: '10000',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('parses a complete environment', () => {
    const config = loadConfig(validEnv);

    expect(config.INDEXER_WORKER_ID).toBe('indexer-local-1');
    expect(config.NODE_ENV).toBe('development');
    expect(config.INDEXER_PORT).toBe(8081);
    expect(config.DB_POOL_MAX).toBe(4);
    expect(config.INDEXER_HEADLESS).toBe(true);
  });

  it('refuses to start without a worker id rather than generating one', () => {
    const { INDEXER_WORKER_ID: _workerId, ...partial } = validEnv;

    try {
      loadConfig(partial);
      expect.unreachable('loadConfig should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join('\n')).toContain('INDEXER_WORKER_ID');
    }
  });

  it('refuses to start without the job stream it consumes', () => {
    const { INDEXER_JOB_STREAM: _stream, ...partial } = validEnv;

    expect(() => loadConfig(partial)).toThrow(ConfigError);
  });

  it('rejects an empty worker id', () => {
    expect(() => loadConfig({ ...validEnv, INDEXER_WORKER_ID: '' })).toThrow(ConfigError);
  });

  it('rejects an unknown environment name', () => {
    expect(() => loadConfig({ ...validEnv, NODE_ENV: 'staging' })).toThrow(ConfigError);
  });

  it('rejects a database URL that is not postgres', () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: 'mysql://localhost/wispr' })).toThrow(
      ConfigError,
    );
  });

  it('rejects a headless flag that is neither true nor false', () => {
    // A truthiness coercion here would turn `INDEXER_HEADLESS=no` into a visible browser on a
    // machine with no display, which fails much later and much less clearly.
    expect(() => loadConfig({ ...validEnv, INDEXER_HEADLESS: 'no' })).toThrow(ConfigError);
  });

  it('treats a missing OTLP endpoint as "export nothing" rather than an error', () => {
    expect(loadConfig(validEnv).OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });
});
