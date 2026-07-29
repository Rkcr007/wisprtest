import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { ConfigError } from './errors.js';

/**
 * Every variable the gateway needs, with values that would pass in a real deployment.
 *
 * Kept complete rather than minimal on purpose: the interesting assertions are what happens
 * when one is removed or corrupted, and each of those starts from here.
 */
const validEnv = {
  NODE_ENV: 'development',
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
  RATE_LIMIT_MAX: '600',
  RATE_LIMIT_WINDOW_MS: '60000',
  MODEL_API_KEY: 'sk-ant-test',
  MODEL_BASE_URL: 'https://api.anthropic.com',
  MODEL_PRIMARY: 'claude-haiku-4-5-20251001',
  MODEL_FALLBACK: 'claude-haiku-4-5-20251001',
  MODEL_TIMEOUT_MS: '800',
  OTEL_SERVICE_NAME: 'wispr-gateway',
  SHUTDOWN_TIMEOUT_MS: '10000',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('parses a complete environment and coerces numbers', () => {
    const config = loadConfig(validEnv);

    expect(config.GATEWAY_HOST).toBe('127.0.0.1');
    expect(config.GATEWAY_PORT).toBe(8080);
    expect(config.DB_POOL_MAX).toBe(10);
    expect(config.RATE_LIMIT_MAX).toBe(600);
    expect(config.NODE_ENV).toBe('development');
  });

  it('names every missing variable, not just the first', () => {
    // A misconfigured deployment should be fixed in one pass, not one restart per variable.
    const { GATEWAY_HOST: _host, DATABASE_URL: _db, OIDC_AUDIENCE: _aud, ...partial } = validEnv;

    try {
      loadConfig(partial);
      expect.unreachable('loadConfig should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues.join('\n');
      expect(issues).toContain('GATEWAY_HOST');
      expect(issues).toContain('DATABASE_URL');
      expect(issues).toContain('OIDC_AUDIENCE');
    }
  });

  it.each([
    ['GATEWAY_PORT', 'not-a-port'],
    ['GATEWAY_PORT', '70000'],
    ['LOG_LEVEL', 'chatty'],
    ['NODE_ENV', 'staging'],
    ['DB_POOL_MAX', '0'],
    ['RATE_LIMIT_MAX', '0'],
    // Below one second is almost certainly a unit mistake — seconds where milliseconds belong.
    ['RATE_LIMIT_WINDOW_MS', '100'],
    ['OIDC_CLOCK_TOLERANCE_SECONDS', '-1'],
    // A five-minute tolerance is not skew, it is an expired token being accepted.
    ['OIDC_CLOCK_TOLERANCE_SECONDS', '3600'],
    ['SHUTDOWN_TIMEOUT_MS', '-1'],
  ])('rejects %s=%j rather than defaulting', (key, value) => {
    expect(() => loadConfig({ ...validEnv, [key]: value })).toThrow(ConfigError);
  });

  it.each([
    ['DATABASE_URL', 'mysql://localhost:3306/wispr'],
    ['DATABASE_URL', 'not-a-url'],
    ['REDIS_URL', 'http://localhost:6379'],
    ['QDRANT_URL', 'redis://localhost:6333'],
    ['OIDC_ISSUER_URL', 'ftp://idp.example'],
  ])('rejects %s with the wrong scheme: %j', (key, value) => {
    // A URL of the wrong kind is the mistake that produces a baffling runtime failure minutes
    // later, in a driver, with a message about something unrelated.
    expect(() => loadConfig({ ...validEnv, [key]: value })).toThrow(ConfigError);
  });

  describe('the two optional variables', () => {
    it('accepts an environment without them', () => {
      // Absent means a stated behaviour, not a silent default: no OTLP endpoint means export
      // nothing, and no JWKS URI means discover it from the issuer.
      const config = loadConfig(validEnv);
      expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
      expect(config.OIDC_JWKS_URI).toBeUndefined();
    });

    it('accepts them when supplied', () => {
      const config = loadConfig({
        ...validEnv,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        OIDC_JWKS_URI: 'https://idp.example/realms/wispr/protocol/openid-connect/certs',
      });

      expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:4318');
      expect(config.OIDC_JWKS_URI).toContain('certs');
    });

    it('still rejects them when present and malformed', () => {
      // Optional means "may be absent", not "may be nonsense".
      expect(() => loadConfig({ ...validEnv, OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url' })).toThrow(
        ConfigError,
      );
    });
  });
});
