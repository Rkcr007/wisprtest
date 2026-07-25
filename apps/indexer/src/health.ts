import { createServer, type Server, type ServerResponse } from 'node:http';

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { TenantDatabase } from './db/pool.js';

/**
 * `/healthz` and `/readyz`.
 *
 * CLAUDE.md rule #6 applies to every service, including one with no API. Without these, an
 * orchestrator has only the process's existence to go on: it will happily leave a worker running
 * that lost its database twenty minutes ago and has been failing every job since, and it will
 * restart a healthy worker in the middle of a crawl because nothing told it otherwise.
 *
 * The split is the usual one and it matters here more than usual:
 *
 * - **`/healthz`** — is the process alive? Answered without touching a dependency. A worker whose
 *   Redis is down must not be killed and restarted; restarting it will not bring Redis back, and
 *   it would abandon the crawl in flight.
 * - **`/readyz`** — can it take work? Checks Postgres and Redis, because a worker that cannot
 *   write memory or read the job stream has nothing useful to do.
 *
 * A third field, `busy`, reports whether a job is in flight. It is informational — a busy worker
 * is still ready — but it is what makes a rolling deploy legible: draining nodes show `busy:true`
 * until their crawl finishes.
 */

export interface HealthServerOptions {
  readonly host: string;
  readonly port: number;
  readonly database: TenantDatabase;
  readonly redis: Redis;
  readonly logger: Logger;
  /** Whether a crawl job is currently running. */
  readonly isBusy: () => boolean;
}

export interface HealthServer {
  readonly port: number;
  close(): Promise<void>;
}

export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];

    if (path === '/healthz') {
      send(response, 200, { status: 'ok', busy: options.isBusy() });
      return;
    }

    if (path === '/readyz') {
      void checkDependencies(options).then((checks) => {
        const ready = Object.values(checks).every((check) => check === 'ok');
        send(response, ready ? 200 : 503, {
          status: ready ? 'ok' : 'unavailable',
          busy: options.isBusy(),
          checks,
        });
      });
      return;
    }

    send(response, 404, { status: 'not_found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    port: addressPort(server, options.port),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Each dependency reports `ok` or a short reason. Both are checked even if the first fails. */
async function checkDependencies(
  options: HealthServerOptions,
): Promise<Record<'postgres' | 'redis', string>> {
  const [postgres, redis] = await Promise.all([
    options.database
      .ping()
      .then(() => 'ok')
      .catch((error: unknown) => describe(error)),
    options.redis
      .ping()
      .then(() => 'ok')
      .catch((error: unknown) => describe(error)),
  ]);

  return { postgres, redis };
}

function send(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function addressPort(server: Server, fallback: number): number {
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : fallback;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unavailable';
}
