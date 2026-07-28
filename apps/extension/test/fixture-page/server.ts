import { createServer, type Server } from 'node:http';

/**
 * The two servers the end-to-end suite runs against.
 *
 * **The page** is a small application with its own layout and its own stylesheet, because the
 * assertion that matters is that mounting the HUD changes none of it. A blank page would prove
 * nothing: everything the HUD could disturb — body margins, a fixed header, a z-index war, the
 * child count of `<body>` — has to exist to be left alone.
 *
 * **The gateway stub** answers the token exchange. The real route does not exist yet (Phase 4
 * built infrastructure only, and the endpoint lands with the phase that first needs an
 * authenticated call), so the suite serves the `ExtensionToken` contract from
 * `packages/protocol` directly. The client under test is the real one; only its counterpart is
 * standing in.
 */

/** Fixed, because they are baked into the extension build's `host_permissions`. */
export const GATEWAY_PORT = 4319;
export const PAGE_PORT = 4320;
/**
 * A second origin serving the same page.
 *
 * Tokens are cached per origin — two tabs on one application are one application — so the failure
 * path needs an origin that has never had a token minted for it. Reusing the first would test the
 * cache rather than the failure.
 */
export const PAGE_ALT_PORT = 4321;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Northwind — Orders</title>
    <style>
      body { margin: 40px; font-family: system-ui, sans-serif; background: #fbfbfd; }
      header { position: fixed; top: 0; left: 0; right: 0; height: 48px; background: #223; color: #fff; z-index: 999999; }
      main { padding-top: 64px; }
      #approve { padding: 8px 16px; }
      #log { font-family: ui-monospace, monospace; }
    </style>
  </head>
  <body>
    <header>Northwind</header>
    <main>
      <h1>Orders</h1>
      <button id="approve">Approve order</button>
      <input id="search" aria-label="Search orders" />
      <p id="log">no clicks</p>
    </main>
    <script>
      // Records that a click reached the application. The HUD's container spans the viewport, so
      // "the page still receives clicks outside the panel" needs the page to be able to say so.
      // The command e2e also reads data-trusted, to prove the CDP-dispatched click carried
      // isTrusted — the exact property an approve button is entitled to gate on.
      document.getElementById('approve').addEventListener('click', (event) => {
        document.getElementById('log').textContent = 'approve clicked';
        document.documentElement.dataset.trusted = String(event.isTrusted);
      });
      // Records typed characters and whether the keystrokes were trusted, for the type verb.
      var search = document.getElementById('search');
      search.addEventListener('keydown', (event) => {
        document.documentElement.dataset.typedTrusted = String(event.isTrusted);
      });
    </script>
  </body>
</html>`;

export interface StubServers {
  readonly pageUrl: string;
  /** The same page on a second origin. See {@link PAGE_ALT_PORT}. */
  readonly altPageUrl: string;
  readonly gatewayOrigin: string;
  /** Token requests the extension made. Lets a test assert the exchange happened at all. */
  readonly tokenRequests: { origin: string }[];
  /** Flips the gateway to rejecting, so the failure path can be exercised for real. */
  setUnauthenticated(value: boolean): void;
  close(): Promise<void>;
}

export async function startServers(): Promise<StubServers> {
  const tokenRequests: { origin: string }[] = [];
  let unauthenticated = false;

  const gateway = createServer((request, response) => {
    if (request.url !== '/v1/auth/extension-token') {
      response.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (unauthenticated) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unauthenticated' }));
        return;
      }

      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { origin?: string };
      tokenRequests.push({ origin: body.origin ?? '' });

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          token: 'e2e.scoped.token',
          tokenType: 'Bearer',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          tenantId: '11111111-1111-4111-8111-111111111111',
          applicationId: '22222222-2222-4222-8222-222222222222',
          scopes: ['memory:read', 'session:write'],
        }),
      );
    });
  });

  const servePage = (): Server =>
    createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE_HTML);
    });

  const page = servePage();
  const altPage = servePage();

  await Promise.all([
    listen(gateway, GATEWAY_PORT),
    listen(page, PAGE_PORT),
    listen(altPage, PAGE_ALT_PORT),
  ]);

  return {
    pageUrl: `http://127.0.0.1:${String(PAGE_PORT)}/orders`,
    altPageUrl: `http://127.0.0.1:${String(PAGE_ALT_PORT)}/orders`,
    gatewayOrigin: `http://127.0.0.1:${String(GATEWAY_PORT)}`,
    tokenRequests,
    setUnauthenticated: (value: boolean) => {
      unauthenticated = value;
    },
    close: async () => {
      await Promise.all([close(gateway), close(page), close(altPage)]);
    },
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      // The ports are fixed because they are compiled into the extension's host_permissions.
      // Saying so beats a bare EADDRINUSE from somewhere inside the suite.
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `port ${String(port)} is in use; the extension end-to-end suite needs ${String(GATEWAY_PORT)} and ${String(PAGE_PORT)}`,
            )
          : error,
      );
    });
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}
