import { describe, expect, it } from 'vitest';

import { buildConsoleSecurityPolicy, ConsoleSecurityError } from './headers';

const NONCE = 'dGVzdC1ub25jZS0xMjM0NTY=';

describe('buildConsoleSecurityPolicy', () => {
  it('requires a nonce for scripts and styles in production', () => {
    const policy = buildConsoleSecurityPolicy(NONCE, 'production');

    expect(policy.contentSecurityPolicy).toContain(
      `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`,
    );
    expect(policy.contentSecurityPolicy).toContain(`style-src 'self' 'nonce-${NONCE}'`);
    expect(policy.contentSecurityPolicy).not.toContain("'unsafe-inline'");
    expect(policy.contentSecurityPolicy).not.toContain("'unsafe-eval'");
    expect(policy.contentSecurityPolicy).toContain('upgrade-insecure-requests');
    expect(policy.headers['Content-Security-Policy']).toBe(policy.contentSecurityPolicy);
  });

  it('permits only the development runtime to evaluate scripts', () => {
    const development = buildConsoleSecurityPolicy(NONCE, 'development');
    const test = buildConsoleSecurityPolicy(NONCE, 'test');

    expect(development.contentSecurityPolicy).toContain("'unsafe-eval'");
    expect(development.contentSecurityPolicy).not.toContain('upgrade-insecure-requests');
    expect(test.contentSecurityPolicy).not.toContain("'unsafe-eval'");
  });

  it('blocks framing, dangerous capabilities, plugins, and external connections', () => {
    const policy = buildConsoleSecurityPolicy(NONCE, 'production');

    expect(policy.contentSecurityPolicy).toContain("connect-src 'self'");
    expect(policy.contentSecurityPolicy).toContain("object-src 'none'");
    expect(policy.contentSecurityPolicy).toContain("frame-ancestors 'none'");
    expect(policy.contentSecurityPolicy).toContain("form-action 'self'");
    expect(policy.headers).toMatchObject({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy':
        'camera=(), geolocation=(), microphone=(), payment=(), usb=(), browsing-topics=()',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
  });

  it.each(['', 'not a nonce', "abc'; script-src *"])('rejects an unsafe nonce: %j', (nonce) => {
    expect(() => buildConsoleSecurityPolicy(nonce, 'production')).toThrow(ConsoleSecurityError);
  });
});
