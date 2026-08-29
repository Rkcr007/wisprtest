import { randomBytes } from 'node:crypto';

import { type NextRequest, NextResponse } from 'next/server';

import { buildConsoleSecurityPolicy } from './src/security/headers';

/**
 * Apply a fresh CSP nonce and the console's security headers to each rendered request.
 *
 * The CSP is also placed on the forwarded request because Next extracts the nonce from that
 * header while rendering and stamps it onto framework scripts. Authentication remains in Server
 * Components and route handlers; this proxy performs no tenant or credential work.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = randomBytes(18).toString('base64');
  const policy = buildConsoleSecurityPolicy(nonce, process.env.NODE_ENV);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy.contentSecurityPolicy);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  for (const [name, value] of Object.entries(policy.headers)) {
    response.headers.set(name, value);
  }

  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
