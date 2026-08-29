import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { proxy } from '../../proxy';

function request(): NextRequest {
  return new NextRequest('https://console.example/applications');
}

function nonceOf(csp: string): string {
  const match = /'nonce-([^']+)'/.exec(csp);
  if (match?.[1] === undefined) throw new Error('response CSP has no nonce');
  return match[1];
}

describe('console security proxy', () => {
  it('applies the CSP and browser hardening headers', () => {
    const response = proxy(request());
    const csp = response.headers.get('content-security-policy');

    expect(csp).not.toBeNull();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(response.headers.get('permissions-policy')).toContain('microphone=()');
  });

  it('generates a different nonce for every request', () => {
    const first = proxy(request()).headers.get('content-security-policy');
    const second = proxy(request()).headers.get('content-security-policy');
    if (first === null || second === null) throw new Error('response CSP is missing');

    expect(nonceOf(first)).not.toBe(nonceOf(second));
  });
});
