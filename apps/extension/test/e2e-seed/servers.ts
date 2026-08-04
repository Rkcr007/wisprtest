import { createServer, type Server } from 'node:http';

/**
 * The two servers behind the seeding end-to-end.
 *
 * **The application under test** is a real HTTP service holding real orders. It has a list that
 * links to each record by its own reference, a create endpoint, and a delete endpoint. It matters
 * that this is real rather than a fixture object: the loop the phase asks for ends with "record
 * exists → revert → record gone", and neither half of that means anything against a stub that
 * simply reports what it was told.
 *
 * **The gateway stub** serves `/v1/seed/plan`, `/v1/seed/execute` and `/v1/seed/revert` against the
 * contracts in `packages/protocol`, and it *actually writes*: `execute` POSTs to the application
 * above, `revert` DELETEs from it. Its counterpart is standing in — the real gateway is proven by
 * `pnpm --filter gateway test:seed`, and this track does not own that module — but everything on
 * the extension's side of the boundary is the shipping code, and the records it creates are real.
 *
 * This is the same division the HUD end-to-end already uses for the token exchange: "the client
 * under test is the real one; only its counterpart is standing in".
 */

/** Fixed ports, so the harness page can be built against a known gateway origin. */
export const APP_PORT = 4331;
export const SEED_GATEWAY_PORT = 4332;

const UUID_TENANT = '11111111-1111-4111-8111-111111111111';
const UUID_SESSION = '33333333-3333-4333-8333-333333333333';
const UUID_MEMORY = '44444444-4444-4444-8444-444444444444';
const UUID_SCHEMA = '55555555-5555-4555-8555-555555555555';

interface OrderRecord {
  readonly externalRef: string;
  readonly status: string;
  readonly amount: number;
  readonly account: string;
}

/** A held plan, exactly as the real gateway holds one: composed, awaiting an approval by id. */
interface HeldPlan {
  readonly planId: string;
  readonly nodes: readonly {
    nodeId: string;
    entity: string;
    fields: Record<string, unknown>;
  }[];
  released: boolean;
}

export interface SeedServers {
  readonly appUrl: string;
  readonly gatewayOrigin: string;
  /** Every order the application currently holds. Read directly, so a test can assert existence. */
  orders(): readonly OrderRecord[];
  /** Requests the gateway stub received, so a test can assert what the extension actually sent. */
  readonly calls: { path: string; body: Record<string, unknown> }[];
  /** Force the next execute to fail, for the chain-reporting path. */
  failNextExecute(reason: string): void;
  /**
   * Put the application back to the one record it started with, and forget every call.
   *
   * Called between tests. Without it each test would inherit whatever the previous one created,
   * and an assertion about "the record this test seeded" would silently be about an older one.
   */
  reset(): void;
  close(): Promise<void>;
}

/** A string field of a JSON body, or a fallback. Keeps `unknown` from reaching `String()`. */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/** A numeric field of a JSON body, or a fallback. */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBody(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      resolve(raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>));
    });
  });
}

/** The orders list, with one link per record whose path carries the record's own reference. */
function listHtml(orders: readonly OrderRecord[]): string {
  const rows = orders
    .map(
      (order) =>
        `<li class="row"><a href="/orders/${order.externalRef}">${order.account} — ${order.status}</a> <span>${String(order.amount)}</span></li>`,
    )
    .join('\n      ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Northwind — Orders</title>
    <style>
      body { margin: 32px; font-family: system-ui, sans-serif; }
      ul { list-style: none; padding: 0; }
      .row { padding: 10px 12px; border-bottom: 1px solid #ddd; }
      a { display: inline-block; min-width: 220px; }
    </style>
  </head>
  <body>
    <h1>Orders</h1>
    <ul id="orders">
      ${rows}
    </ul>
    <div id="harness"></div>
    <script src="/harness.js"></script>
  </body>
</html>`;
}

export async function startSeedServers(harnessJs: string): Promise<SeedServers> {
  const orders: OrderRecord[] = [
    { externalRef: 'ORD-1001', status: 'Approved', account: 'Globex', amount: 1200 },
  ];
  const plans = new Map<string, HeldPlan>();
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let nextExecuteFailure: string | null = null;
  let counter = 4900;

  const app = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${String(APP_PORT)}`);

    if (request.method === 'GET' && url.pathname === '/harness.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(harnessJs);
      return;
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/orders')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(listHtml(orders));
      return;
    }

    // The detail route. Its existence is what makes the list's links real links.
    const detail = /^\/orders\/([\w-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && detail !== null) {
      const ref = detail[1] ?? '';
      const order = orders.find((candidate) => candidate.externalRef === ref);
      response.writeHead(order === undefined ? 404 : 200, {
        'content-type': 'text/html; charset=utf-8',
      });
      response.end(order === undefined ? 'not found' : `<h1>${order.externalRef}</h1>`);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/orders') {
      void readBody(request).then((body) => {
        counter += 1;
        const created: OrderRecord = {
          externalRef: `ORD-${String(counter)}`,
          status: text(body.status, 'Pending'),
          account: text(body.account, 'Unknown'),
          amount: num(body.amount, 0),
        };
        orders.push(created);
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify(created));
      });
      return;
    }

    if (request.method === 'DELETE' && detail !== null) {
      const ref = detail[1] ?? '';
      const index = orders.findIndex((candidate) => candidate.externalRef === ref);
      if (index >= 0) orders.splice(index, 1);
      response.writeHead(index >= 0 ? 204 : 404).end();
      return;
    }

    response.writeHead(404).end();
  });

  const appOrigin = `http://127.0.0.1:${String(APP_PORT)}`;

  const gateway = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${String(SEED_GATEWAY_PORT)}`);

    // The extension's fetch is cross-origin, so the browser preflights it.
    const cors = {
      'access-control-allow-origin': appOrigin,
      'access-control-allow-headers': 'content-type,authorization',
      'access-control-allow-methods': 'POST,OPTIONS',
    };

    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors).end();
      return;
    }

    void readBody(request).then(async (body) => {
      calls.push({ path: url.pathname, body });
      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { ...cors, 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      if (url.pathname === '/v1/seed/plan') {
        const planId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(plans.size).padStart(12, '0')}`;
        const fields = { status: 'Pending', account: 'Acme Industrial', amount: 4200 };
        plans.set(planId, {
          planId,
          nodes: [{ nodeId: 'order-1', entity: 'Order', fields }],
          released: false,
        });

        send(200, {
          composition: {
            constraintSet: {
              entity: 'Order',
              constraints: [{ kind: 'equals', field: 'status', value: 'Pending' }],
              unparsedFragments: [],
              confidence: 0.94,
            },
            outcome: {
              kind: 'planned',
              plan: {
                id: planId,
                tenantId: UUID_TENANT,
                sessionId: UUID_SESSION,
                memoryVersionId: UUID_MEMORY,
                rootNodeId: 'order-1',
                nodes: [
                  {
                    nodeId: 'order-1',
                    entity: 'Order',
                    entitySchemaId: UUID_SCHEMA,
                    mode: 'create',
                    existingExternalRef: null,
                    fields,
                    provenance: [
                      {
                        field: 'status',
                        value: 'Pending',
                        source: 'requested',
                        explanation: 'you asked for a pending order',
                        confidence: 1,
                      },
                      {
                        field: 'account',
                        value: 'Acme Industrial',
                        source: 'reference_matched',
                        explanation: 'matched from 64 known accounts',
                        confidence: 0.97,
                      },
                      {
                        field: 'amount',
                        value: 4200,
                        source: 'sampled',
                        explanation: 'sampled from 312 observed orders (median 3,980)',
                        confidence: 0.82,
                      },
                    ],
                  },
                ],
                edges: [],
                materializationOrder: ['order-1'],
                constraintSet: {
                  entity: 'Order',
                  constraints: [{ kind: 'equals', field: 'status', value: 'Pending' }],
                  unparsedFragments: [],
                  confidence: 0.94,
                },
                createdAt: new Date().toISOString(),
              },
              aliasWriteBacks: [],
            },
            parseTier: 'T0',
            durationMs: 210,
          },
          planId,
          preview: [
            {
              nodeId: 'order-1',
              entity: 'Order',
              mode: 'create',
              adapter: 'ui',
              adapterReason: 'no API materializer was observed, so the real create form will run',
              revert: {
                revertible: true,
                kind: 'ui',
                detail: 'drives the indexed delete flow on /orders/:id',
              },
            },
          ],
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        });
        return;
      }

      if (url.pathname === '/v1/seed/execute') {
        const planId = text(body.planId, '');
        const held = plans.get(planId);
        if (held === undefined || held.released) {
          // Exactly what the real gateway does: a plan is released once run, so one approval
          // cannot become two rows.
          send(409, { code: 'plan_not_held', message: 'no such plan is being held' });
          return;
        }
        held.released = true;

        if (nextExecuteFailure !== null) {
          const reason = nextExecuteFailure;
          nextExecuteFailure = null;
          send(200, {
            result: {
              planId,
              outcome: 'failed',
              adapterUsed: null,
              attempts: [{ adapter: 'ui', outcome: 'failed', reason, durationMs: 900 }],
              records: [],
              verifiedAt: null,
              failureReason: reason,
              durationMs: 950,
            },
            ledger: [],
          });
          return;
        }

        // The write. A real POST to the real application, which is what makes "record exists"
        // an assertion about the world rather than about this stub.
        const node = held.nodes[0];
        const created = (await fetch(`${appOrigin}/orders`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(node?.fields ?? {}),
        }).then((res) => res.json())) as OrderRecord;

        send(200, {
          result: {
            planId,
            outcome: 'created',
            adapterUsed: 'ui',
            attempts: [{ adapter: 'ui', outcome: 'succeeded', reason: null, durationMs: 4100 }],
            records: [
              {
                nodeId: 'order-1',
                entity: 'Order',
                externalRef: created.externalRef,
                payload: node?.fields ?? {},
                inverseOp: { kind: 'ui', flow: 'orders.detail.delete' },
              },
            ],
            verifiedAt: new Date().toISOString(),
            failureReason: null,
            durationMs: 4200,
          },
          ledger: [
            {
              id: `bbbbbbbb-bbbb-4bbb-8bbb-${created.externalRef.replace(/\D/g, '').padStart(12, '0')}`,
              tenantId: UUID_TENANT,
              sessionId: UUID_SESSION,
              planId,
              nodeId: 'order-1',
              entitySchemaId: UUID_SCHEMA,
              entity: 'Order',
              externalRef: created.externalRef,
              adapterUsed: 'ui',
              payload: node?.fields ?? {},
              provenance: [],
              inverseOp: { kind: 'ui', flow: 'orders.detail.delete' },
              createdAt: new Date().toISOString(),
              revertedAt: null,
            },
          ],
        });
        return;
      }

      if (url.pathname === '/v1/seed/revert') {
        // Everything this session seeded: every order except the one the app started with.
        const seeded = orders.filter((order) => order.externalRef !== 'ORD-1001');
        const outcomes = [];
        for (const order of seeded) {
          // The real delete, against the real application.
          const removed = await fetch(`${appOrigin}/orders/${order.externalRef}`, {
            method: 'DELETE',
          });
          outcomes.push({
            ledgerEntryId: `bbbbbbbb-bbbb-4bbb-8bbb-${order.externalRef.replace(/\D/g, '').padStart(12, '0')}`,
            entity: 'Order',
            externalRef: order.externalRef,
            outcome: removed.ok ? 'reverted' : 'failed',
            reason: removed.ok ? null : 'the delete flow did not remove the record',
          });
        }
        send(200, { outcomes, durationMs: 1200 });
        return;
      }

      send(404, { code: 'not_found', message: 'no such route' });
    });
  });

  await Promise.all([
    new Promise<void>((resolve) => {
      app.listen(APP_PORT, '127.0.0.1', resolve);
    }),
    new Promise<void>((resolve) => {
      gateway.listen(SEED_GATEWAY_PORT, '127.0.0.1', resolve);
    }),
  ]);

  const closeServer = (server: Server): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });

  return {
    appUrl: `${appOrigin}/orders`,
    gatewayOrigin: `http://127.0.0.1:${String(SEED_GATEWAY_PORT)}`,
    orders: () => [...orders],
    calls,
    failNextExecute: (reason) => {
      nextExecuteFailure = reason;
    },
    reset: () => {
      orders.splice(0, orders.length, {
        externalRef: 'ORD-1001',
        status: 'Approved',
        account: 'Globex',
        amount: 1200,
      });
      plans.clear();
      calls.length = 0;
      nextExecuteFailure = null;
    },
    close: async () => {
      await Promise.all([closeServer(app), closeServer(gateway)]);
    },
  };
}
