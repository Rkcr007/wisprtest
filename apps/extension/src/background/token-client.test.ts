/**
 * @vitest-environment node
 *
 * This file runs in Node rather than happy-dom. happy-dom applies the browser's same-origin
 * policy to `fetch`, and a service worker's fetch is not subject to it — an extension worker's
 * network access is governed by `host_permissions`, which is a different mechanism entirely.
 * Under the DOM environment every request in this file would fail as a CORS error and the suite
 * would be testing happy-dom's policy engine.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ExtensionToken } from 'protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTokenClient,
  GatewayUnreachableError,
  isUsable,
  MalformedTokenError,
  TOKEN_PATH,
  UnauthenticatedError,
} from './token-client.js';

/**
 * Tested against a real HTTP server, not a mocked `fetch`.
 *
 * Every behaviour that matters here is about what the *transport* does — a connection refused, a
 * 401 with a body, a 500 that succeeds on retry — and a stubbed `fetch` would be asserting that
 * the code calls the function it calls. The server is a few lines; the fidelity is worth it.
 *
 * The gateway route this client calls does not exist yet: Phase 4 built infrastructure only, and
 * the endpoint lands with the phase that first needs an authenticated call. The contract it is
 * written against is `ExtensionToken` in `packages/protocol`, which is what both sides will use.
 */

interface Route {
  status: number;
  body: unknown;
  /** Incremented per request, so a test can assert retries happened — or did not. */
  calls: number;
}

let server: Server | undefined;

async function serve(route: Route): Promise<string> {
  server = createServer((request, response) => {
    route.calls += 1;

    if (request.url !== TOKEN_PATH) {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(route.status, { 'content-type': 'application/json' });
    response.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body));
  });

  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) {
      resolve();
      return;
    }
    server.close(() => {
      resolve();
    });
  });
  server = undefined;
});

const validToken: ExtensionToken = {
  token: 'a.scoped.token',
  tokenType: 'Bearer',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  tenantId: '11111111-1111-4111-8111-111111111111',
  applicationId: '22222222-2222-4222-8222-222222222222',
  scopes: ['memory:read', 'session:write'],
};

const noSleep = (): Promise<void> => Promise.resolve();

describe('minting a token', () => {
  it('returns a token the gateway issued', async () => {
    const route: Route = { status: 200, body: validToken, calls: 0 };
    const origin = await serve(route);

    const client = createTokenClient({ gatewayOrigin: origin, sleep: noSleep });
    const token = await client.fetchToken('https://orders.example');

    expect(token.token).toBe('a.scoped.token');
    expect(token.scopes).toContain('memory:read');
    expect(route.calls).toBe(1);
  });

  it('sends the origin it wants a token for', async () => {
    const bodies: unknown[] = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(validToken));
      });
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;

    const client = createTokenClient({
      gatewayOrigin: `http://127.0.0.1:${String(port)}`,
      sleep: noSleep,
    });
    await client.fetchToken('https://orders.example');

    // An origin, not a URL: a path can carry a record id, and the gateway resolves the
    // application from the origin anyway.
    expect(bodies).toEqual([{ origin: 'https://orders.example' }]);
  });
});

describe('failing closed', () => {
  it('does not retry a rejected session, and says to sign in', async () => {
    const route: Route = { status: 401, body: { error: 'unauthenticated' }, calls: 0 };
    const origin = await serve(route);

    const client = createTokenClient({ gatewayOrigin: origin, sleep: noSleep, maxAttempts: 3 });

    await expect(client.fetchToken('https://orders.example')).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    // Retrying an auth failure hammers the identity provider and can lock the tester's account.
    expect(route.calls).toBe(1);
  });

  it('treats a 403 the same way', async () => {
    const route: Route = { status: 403, body: {}, calls: 0 };
    const origin = await serve(route);

    const client = createTokenClient({ gatewayOrigin: origin, sleep: noSleep });

    await expect(client.fetchToken('https://orders.example')).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    expect(route.calls).toBe(1);
  });

  it('rejects a response that is not an ExtensionToken', async () => {
    // An unvalidated token would be stored, scheduled for refresh and used: three ways for one
    // bad response to spread.
    const route: Route = { status: 200, body: { token: 'x', tokenType: 'Bearer' }, calls: 0 };
    const origin = await serve(route);

    const client = createTokenClient({ gatewayOrigin: origin, sleep: noSleep });

    await expect(client.fetchToken('https://orders.example')).rejects.toBeInstanceOf(
      MalformedTokenError,
    );
  });

  it('rejects a token with no scopes', async () => {
    const route: Route = { status: 200, body: { ...validToken, scopes: [] }, calls: 0 };
    const origin = await serve(route);

    const client = createTokenClient({ gatewayOrigin: origin, sleep: noSleep });

    await expect(client.fetchToken('https://orders.example')).rejects.toBeInstanceOf(
      MalformedTokenError,
    );
  });

  it('gives up with a typed error when the gateway is not there at all', async () => {
    // Nothing is listening on this port. The service worker has to be able to tell the tester
    // "the control plane did not answer", not throw a fetch error into the console.
    const client = createTokenClient({
      gatewayOrigin: 'http://127.0.0.1:9',
      sleep: noSleep,
      maxAttempts: 2,
    });

    await expect(client.fetchToken('https://orders.example')).rejects.toBeInstanceOf(
      GatewayUnreachableError,
    );
  });
});

describe('retrying', () => {
  it('retries a 500 and succeeds when the gateway recovers', async () => {
    let calls = 0;
    server = createServer((_request, response) => {
      calls += 1;
      if (calls < 3) {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(validToken));
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;

    const client = createTokenClient({
      gatewayOrigin: `http://127.0.0.1:${String(port)}`,
      sleep: noSleep,
      maxAttempts: 3,
    });

    await expect(client.fetchToken('https://orders.example')).resolves.toMatchObject({
      token: 'a.scoped.token',
    });
    expect(calls).toBe(3);
  });

  it('backs off exponentially rather than hammering', async () => {
    const route: Route = { status: 500, body: {}, calls: 0 };
    const origin = await serve(route);
    const sleep = vi.fn(() => Promise.resolve());

    const client = createTokenClient({
      gatewayOrigin: origin,
      sleep,
      maxAttempts: 3,
      backoffMs: 100,
    });

    await expect(client.fetchToken('https://orders.example')).rejects.toBeInstanceOf(
      GatewayUnreachableError,
    );
    // Two waits for three attempts, doubling. A fixed delay would turn a struggling gateway into
    // a gateway under load from every attached tab at once.
    expect(sleep.mock.calls).toEqual([[100], [200]]);
  });

  it('retries a 429 as well, since it is a request to slow down', async () => {
    const route: Route = { status: 429, body: {}, calls: 0 };
    const origin = await serve(route);

    const client = createTokenClient({ gatewayOrigin: origin, sleep: noSleep, maxAttempts: 2 });

    await expect(client.fetchToken('https://orders.example')).rejects.toBeInstanceOf(
      GatewayUnreachableError,
    );
    expect(route.calls).toBe(2);
  });
});

describe('isUsable', () => {
  it('rejects a token that expires inside the margin', () => {
    const now = Date.now();
    const soon: ExtensionToken = { ...validToken, expiresAt: new Date(now + 2_000).toISOString() };

    // Two seconds is not enough: the request it would authorise takes longer than that to land.
    expect(isUsable(soon, now, 60_000)).toBe(false);
    expect(isUsable(validToken, now, 60_000)).toBe(true);
  });
});
