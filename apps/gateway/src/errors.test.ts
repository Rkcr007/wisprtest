import { WisprError, WisprErrorCode } from 'protocol';
import { describe, expect, it } from 'vitest';

import {
  asWisprError,
  ConfigError,
  ForbiddenError,
  GatewayError,
  HTTP_STATUS_BY_CODE,
  httpStatusFor,
  RateLimitedError,
  TenantContextMissingError,
  toWisprError,
  UnauthorizedError,
} from './errors.js';

const TRACE = 'a'.repeat(32);

describe('the status table', () => {
  it('covers every protocol error code', () => {
    // `satisfies` makes this a compile error too. Asserted at runtime as well so the failure is
    // legible: a code added to the contract without a decision about its status cannot ship.
    for (const code of WisprErrorCode.options) {
      expect(HTTP_STATUS_BY_CODE, `no status mapped for ${code}`).toHaveProperty(code);
    }
  });

  it('maps every code to a plausible HTTP status', () => {
    for (const [code, status] of Object.entries(HTTP_STATUS_BY_CODE)) {
      expect(status, `${code} maps to ${String(status)}`).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThanOrEqual(599);
    }
  });

  it.each([
    ['unauthorized', 401],
    ['forbidden', 403],
    ['rate_limited', 429],
    ['validation_failed', 400],
    ['internal', 500],
    ['seeding_forbidden', 403],
    ['constraint_unsatisfiable', 422],
  ] as const)('%s → %i', (code, status) => {
    expect(httpStatusFor(code)).toBe(status);
  });
});

describe('toWisprError', () => {
  it('always produces something the contract itself accepts', () => {
    // Every branch, including the ones for values that are not errors at all. A handler that
    // throws while handling a failure is how a 500 becomes a hung connection.
    const thrown: unknown[] = [
      new UnauthorizedError('no header'),
      new ForbiddenError('seed:execute', 'lead'),
      new RateLimitedError(30),
      new TenantContextMissingError('list-users'),
      new ConfigError(['DATABASE_URL: required']),
      new GatewayError('materialization_failed', 'adapter failed'),
      new Error('plain'),
      'a string',
      null,
      undefined,
      { nonsense: true },
    ];

    for (const value of thrown) {
      const result = WisprError.safeParse(toWisprError(value, TRACE));
      expect(result.success, `failed for ${String(value)}`).toBe(true);
    }
  });

  it('withholds internal detail from the body but keeps the trace id', () => {
    const error = new TenantContextMissingError('list-applications');
    const body = toWisprError(error, TRACE);

    expect(body.code).toBe('internal');
    expect(body.message).not.toContain('list-applications');
    expect(body).toMatchObject({ traceId: TRACE, retryable: true });
  });

  it('reports a config failure as internal rather than naming the variable', () => {
    // A response that named the missing environment variable would be telling an unauthenticated
    // caller about the deployment.
    const body = toWisprError(new ConfigError(['DATABASE_URL: required']), TRACE);

    expect(body.code).toBe('internal');
    expect(JSON.stringify(body)).not.toContain('DATABASE_URL');
  });

  it('gives every unauthorized failure the same body, whatever the reason', () => {
    const first = toWisprError(new UnauthorizedError('token expired'), TRACE);
    const second = toWisprError(new UnauthorizedError('signature invalid'), TRACE);

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).not.toContain('expired');
  });

  it('carries the role a forbidden action needs', () => {
    const body = toWisprError(new ForbiddenError('admin:manage', 'owner'), TRACE);
    expect(body).toMatchObject({ code: 'forbidden', requiredRole: 'owner' });
  });

  it('carries the retry delay on a rate limit', () => {
    expect(toWisprError(new RateLimitedError(45), TRACE)).toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: 45,
      retryable: true,
    });
  });

  it('reports a protocol code with no richer construction as internal, not half-built', () => {
    // A partially-populated variant would fail the contract's own schema, which is worse than
    // an honest 500.
    const body = toWisprError(new GatewayError('constraint_unsatisfiable', 'clash'), TRACE);
    expect(body.code).toBe('internal');
  });
});

describe('asWisprError', () => {
  it('passes through a payload that already satisfies the contract', () => {
    // How a plugin's own error body reaches the handler — `@fastify/rate-limit` throws one.
    const payload = {
      code: 'rate_limited',
      message: 'too many requests',
      retryable: true,
      retryAfterSeconds: 12,
    };
    expect(asWisprError(payload)).toEqual(payload);
  });

  it('rejects a payload that merely looks close', () => {
    // Validated by the schema, not by a shape guess. A body with a plausible `code` but the
    // wrong fields would otherwise be forwarded to a client that then fails to parse it.
    expect(asWisprError({ code: 'rate_limited', message: 'x' })).toBeNull();
    expect(asWisprError({ code: 'not_a_real_code', message: 'x', retryable: true })).toBeNull();
    expect(asWisprError('rate_limited')).toBeNull();
    expect(asWisprError(null)).toBeNull();
  });
});
