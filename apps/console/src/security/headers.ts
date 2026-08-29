/**
 * Browser security policy for the console.
 *
 * The policy is built per request because Next.js applies nonces to its framework scripts during
 * dynamic rendering. Keeping the directives here, separate from `proxy.ts`, makes the production
 * policy directly testable without depending on Next's internal middleware headers.
 */

export interface ConsoleSecurityPolicy {
  readonly contentSecurityPolicy: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A security policy could not be built or attached safely. */
export class ConsoleSecurityError extends Error {
  readonly code = 'console_security_invalid' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ConsoleSecurityError';
  }
}

/**
 * Build the nonce-based CSP and the response headers that accompany it.
 *
 * `unsafe-eval` exists only for the development overlay and Fast Refresh. Production scripts and
 * styles require the request nonce; inline style attributes are removed from the console rather
 * than permitted by `unsafe-inline`.
 */
export function buildConsoleSecurityPolicy(
  nonce: string,
  environment: string | undefined,
): ConsoleSecurityPolicy {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(nonce)) {
    throw new ConsoleSecurityError('CSP nonce must be a non-empty base64 value');
  }

  const development = environment === 'development';
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    ...(development ? [] : ['upgrade-insecure-requests']),
  ];
  const contentSecurityPolicy = directives.join('; ');

  return {
    contentSecurityPolicy,
    headers: {
      'Content-Security-Policy': contentSecurityPolicy,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy':
        'camera=(), geolocation=(), microphone=(), payment=(), usb=(), browsing-topics=()',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  };
}
