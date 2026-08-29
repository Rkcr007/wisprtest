import { describe, expect, it } from 'vitest';

import type { ConsoleConfig } from '../config';
import { ConsoleError } from '../errors';
import { assertExtensionMintCaller } from './mint-caller';

const cfg: ConsoleConfig = {
  NODE_ENV: 'test' as const,
  LOG_LEVEL: 'info' as const,
  CONSOLE_PORT: 3000,
  GATEWAY_URL: 'http://gateway.internal:8080',
  OIDC_ISSUER_URL: 'https://id.example.com',
  OIDC_AUDIENCE: 'https://api.wisprtest.com',
  OIDC_CLIENT_ID: 'console',
  OIDC_REDIRECT_URI: 'http://localhost:3000/auth/callback',
  CONSOLE_SESSION_SECRET: 'a-console-session-secret-of-at-least-32-chars',
};

function request(origin: string | null): Request {
  const headers = new Headers();
  if (origin !== null) headers.set('origin', origin);
  return new Request('http://localhost:3000/api/auth/extension-token', {
    method: 'POST',
    headers,
  });
}

describe('assertExtensionMintCaller', () => {
  it('allows the console’s own origin', () => {
    expect(() => {
      assertExtensionMintCaller(request('http://localhost:3000'), cfg);
    }).not.toThrow();
  });

  it('allows a packed extension', () => {
    expect(() => {
      assertExtensionMintCaller(
        request('chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef'),
        cfg,
      );
    }).not.toThrow();
  });

  it('refuses a foreign page, including a missing Origin', () => {
    expect(() => {
      assertExtensionMintCaller(request('https://evil.example'), cfg);
    }).toThrow(ConsoleError);
    expect(() => {
      assertExtensionMintCaller(request(null), cfg);
    }).toThrow(ConsoleError);
  });
});
