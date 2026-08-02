import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config';

const validEnv = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  CONSOLE_PORT: '3000',
  GATEWAY_URL: 'http://localhost:8080',
  OIDC_ISSUER_URL: 'https://id.example.com',
  OIDC_AUDIENCE: 'https://api.wisprtest.com',
  OIDC_CLIENT_ID: 'console',
  OIDC_REDIRECT_URI: 'http://localhost:3000/auth/callback',
  CONSOLE_SESSION_SECRET: 'a-console-session-secret-of-at-least-32-chars',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('parses a complete environment and coerces the port', () => {
    expect(loadConfig(validEnv).CONSOLE_PORT).toBe(3000);
  });

  it('refuses to boot without a port', () => {
    const { CONSOLE_PORT: _port, ...partial } = validEnv;

    try {
      loadConfig(partial);
      expect.unreachable('loadConfig should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join('\n')).toContain('CONSOLE_PORT');
    }
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadConfig({ ...validEnv, CONSOLE_PORT: 'three thousand' })).toThrow(ConfigError);
  });

  /**
   * CLAUDE.md rule #10: boot fails loudly on missing config rather than defaulting. Each of these
   * is something the console cannot invent — an unset `GATEWAY_URL` becomes `undefined` in a
   * fetch URL, and an unset `CONSOLE_SESSION_SECRET` would mean a cookie key nobody chose.
   */
  it.each([
    'GATEWAY_URL',
    'OIDC_ISSUER_URL',
    'OIDC_AUDIENCE',
    'OIDC_CLIENT_ID',
    'OIDC_REDIRECT_URI',
    'CONSOLE_SESSION_SECRET',
  ])('refuses to boot without %s, and names it', (variable) => {
    const { [variable]: _removed, ...partial } = validEnv as Record<string, string>;

    try {
      loadConfig(partial);
      expect.unreachable('loadConfig should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join('\n')).toContain(variable);
    }
  });

  it('treats the client secret as optional — a public client has none', () => {
    // RFC 7636: a confidential secret adds nothing for a client that cannot keep one, and PKCE
    // is what protects the exchange either way.
    expect(loadConfig(validEnv).OIDC_CLIENT_SECRET).toBeUndefined();
    expect(loadConfig({ ...validEnv, OIDC_CLIENT_SECRET: 's3cret' }).OIDC_CLIENT_SECRET).toBe('s3cret');
  });

  it('refuses a session secret too short to key the cookie', () => {
    expect(() => loadConfig({ ...validEnv, CONSOLE_SESSION_SECRET: 'short' })).toThrow(ConfigError);
  });

  it.each([
    ['GATEWAY_URL', 'gateway.internal'],
    ['OIDC_ISSUER_URL', 'id.example.com'],
    ['OIDC_REDIRECT_URI', '/auth/callback'],
  ])('refuses %s that is not an absolute http(s) URL', (variable, value) => {
    expect(() => loadConfig({ ...validEnv, [variable]: value })).toThrow(ConfigError);
  });

  it('refuses a non-http scheme for the gateway', () => {
    expect(() => loadConfig({ ...validEnv, GATEWAY_URL: 'file:///etc/passwd' })).toThrow(ConfigError);
  });

  it('reports every missing variable at once rather than one per restart', () => {
    try {
      loadConfig({ NODE_ENV: 'development', LOG_LEVEL: 'info' });
      expect.unreachable('loadConfig should have thrown');
    } catch (error: unknown) {
      expect((error as ConfigError).issues.length).toBeGreaterThan(5);
    }
  });
});
