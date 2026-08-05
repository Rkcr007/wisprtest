import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express, { type Express } from 'express';

import {
  DUE_OFFSET_DAYS,
  FixtureState,
  TITLE_SEPARATOR,
  type Order,
  type OrderLine,
} from './data.js';
import {
  homePage,
  newOrderPage,
  notFoundPage,
  orderDetailPage,
  ordersPage,
  settingsPage,
} from './views.js';

/**
 * A small but real application for the indexer to crawl.
 *
 * Five routes, a create form and a table, per docs/BUILD-PLAN.md Phase 5 — and deliberately a
 * real Express application rather than a set of static files or a mocked page. The crawl has to
 * deal with actual navigation, actual redirects, actual 404s and actual form endpoints, and none
 * of those exist in a fixture that only serves markup.
 *
 * | Route            | What it exercises |
 * |------------------|-------------------|
 * | `/`              | The entry point, and links into the rest |
 * | `/orders`        | A table, repeated controls per row, a filter link, a destructive button |
 * | `/orders/:id`    | Route generalisation — three concrete ids, one screen |
 * | `/orders/new`    | A form: labelled inputs, a select, a submitter that must never be pressed |
 * | `/settings`      | A second form, and a destructive control that is not a form submitter |
 *
 * Phase 13 adds a JSON API alongside the pages, because the schema observers learn from traffic
 * rather than from markup alone:
 *
 * | Endpoint                     | What it exercises |
 * |------------------------------|-------------------|
 * | `GET /api/v2/orders`         | Fifty records: distributions, enums, ranges, derived rules |
 * | `GET /api/v2/accounts`       | The second collection a referential edge needs to point at |
 * | `POST /api/v2/orders`        | The create request, observable because `X-Dry-Run` makes it compute without writing |
 *
 * Phase 16 adds `POST /__seed/orders` and its teardown, for the fixture adapter. Nothing links to
 * them and no page calls them: a fixture materializer is configured by a customer's platform team,
 * never learned by crawling, and the fixture app should not pretend otherwise.
 *
 * Note what the dry-run header means for the API adapter. The only create request a crawl can
 * observe here is the priced preview the form issues, so the API materializer it infers replays a
 * request that, as observed, wrote nothing. The replay omits the header and does write — and the
 * only thing that distinguishes those two outcomes is reading the record back afterwards. That is
 * the case verification exists for, and this fixture is where it is actually exercised.
 */

export interface FixtureApp {
  readonly url: string;
  readonly state: FixtureState;
  close(): Promise<void>;
}

/** The header that turns a create request into a priced preview. */
const DRY_RUN_HEADER = 'x-dry-run';

interface OrderPayload {
  readonly accountId?: string;
  readonly customer?: string;
  readonly po_number?: string;
  readonly status?: Order['status'];
  readonly terms?: Order['terms'];
  readonly notes?: string;
  readonly lines?: readonly Partial<OrderLine>[];
}

/**
 * Price a create payload without writing it.
 *
 * The same computation the stored records satisfy — which is the point: an observer that learns
 * `amount = Σ lines[].amount` from the collection is learning something the create path really
 * does honour, not a coincidence of how the fixture was seeded.
 */
function priceOrder(payload: OrderPayload): Record<string, unknown> {
  const lines = (payload.lines ?? []).map((line) => ({
    sku: line.sku ?? '',
    description: line.description ?? '',
    quantity: line.quantity ?? 0,
    amount: line.amount ?? 0,
  }));

  const amount = Math.round(lines.reduce((total, line) => total + line.amount, 0) * 100) / 100;
  const createdAt = new Date().toISOString();
  const reference = 'ORD-DRAFT';
  const poNumber = payload.po_number ?? '';

  return {
    reference,
    accountId: payload.accountId ?? '',
    customer: payload.customer ?? '',
    amount,
    status: payload.status ?? 'pending',
    terms: payload.terms ?? 'net30',
    po_number: poNumber,
    title: `${reference}${TITLE_SEPARATOR}${poNumber}`,
    lineCount: lines.length,
    largestLine: lines.reduce((highest, line) => Math.max(highest, line.amount), 0),
    createdAt,
    dueAt: new Date(Date.parse(createdAt) + DUE_OFFSET_DAYS * 86_400_000).toISOString(),
    notes: payload.notes ?? '',
    lines,
  };
}

export function buildApp(state: FixtureState): Express {
  const app = express();
  // `extended` so the create form's `lines[0][sku]` controls parse into a nested group rather
  // than into keys with brackets in their names.
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.get('/', (_request, response) => {
    response.type('html').send(homePage(state.orders.length));
  });

  app.get('/orders', (request, response) => {
    const status = typeof request.query.status === 'string' ? request.query.status : undefined;
    const orders =
      status === undefined ? state.orders : state.orders.filter((order) => order.status === status);
    response.type('html').send(ordersPage(orders));
  });

  // Ordered before `/orders/:id` so `new` is a page rather than an order reference.
  app.get('/orders/new', (_request, response) => {
    response.type('html').send(newOrderPage());
  });

  app.get('/orders/:id', (request, response) => {
    const order = state.find(Number(request.params.id));
    if (order === undefined) {
      response.status(404).type('html').send(notFoundPage());
      return;
    }
    response.type('html').send(orderDetailPage(order));
  });

  app.get('/settings', (_request, response) => {
    response.type('html').send(settingsPage());
  });

  // ── The JSON API ──────────────────────────────────────────────────────────────────────────
  // Read-only but for the create endpoint, which writes only when it is not asked for a dry run.

  app.get('/api/v2/orders', (request, response) => {
    const limit = Number(request.query.limit ?? state.orders.length);
    response.json({
      data: state.orders.slice(0, Number.isFinite(limit) ? limit : state.orders.length),
    });
  });

  app.get('/api/v2/orders/:id', (request, response) => {
    const order = state.find(Number(request.params.id));
    if (order === undefined) {
      response.status(404).json({ error: 'not found' });
      return;
    }
    response.json({ data: order });
  });

  app.get('/api/v2/accounts', (_request, response) => {
    response.json({ data: state.accounts });
  });

  app.post('/api/v2/orders', (request, response) => {
    const payload = request.body as OrderPayload;
    const priced = priceOrder(payload);

    // A dry run computes and returns. Nothing is written, and the mutation log stays empty —
    // which is what makes this request safe for a crawl to observe.
    if (request.get(DRY_RUN_HEADER) !== undefined) {
      response.json(priced);
      return;
    }

    const order = state.create(
      payload.customer ?? 'unnamed',
      Number(priced.amount ?? 0),
      payload.status ?? 'pending',
    );
    response.status(201).json({ data: order });
  });

  // ── Mutating endpoints ────────────────────────────────────────────────────────────────────
  // Every one of these is real. A crawl that reaches any of them has committed state in the
  // application under test, and the mutation log will show it.

  app.post('/orders', (request, response) => {
    const body = request.body as Record<string, string | undefined>;
    const order = state.create(
      body.customer ?? 'unnamed',
      Number(body.amount ?? 0),
      (body.status as Order['status'] | undefined) ?? 'pending',
    );
    response.redirect(303, `/orders/${String(order.id)}`);
  });

  app.post('/orders/:id/delete', (request, response) => {
    state.remove(Number(request.params.id));
    response.redirect(303, '/orders');
  });

  app.post('/orders/:id/approve', (request, response) => {
    state.approve(Number(request.params.id));
    response.redirect(303, `/orders/${request.params.id}`);
  });

  app.post('/settings', (request, response) => {
    const body = request.body as Record<string, string | undefined>;
    state.recordSettingsChange(body.digest ?? '');
    response.redirect(303, '/settings');
  });

  // ── The customer's sanctioned seeding endpoint ────────────────────────────────────────────
  // Phase 16's fixture adapter. Deliberately *not* discoverable by crawling: nothing in the
  // application links to it and no page calls it, which is exactly the point — a fixture
  // materializer is configured by the customer's platform team, not learned by observation. It
  // stands in for the seeding route a real staging deployment exposes for test data.

  app.post('/__seed/orders', (request, response) => {
    const payload = request.body as OrderPayload;
    const order = state.create(
      payload.customer ?? 'unnamed',
      Number(priceOrder(payload).amount ?? 0),
      payload.status ?? 'pending',
    );
    response.status(201).json({ data: order });
  });

  app.post('/__seed/orders/teardown', (request, response) => {
    // The convention the adapter posts: which entity, and which record. See `seed/http.ts`.
    const body = request.body as { entity?: string; externalRef?: string };
    const removed = state.remove(Number(body.externalRef));
    response.status(removed ? 204 : 404).end();
  });

  app.post('/settings/purge', (_request, response) => {
    for (const order of [...state.orders]) state.remove(order.id);
    response.status(204).end();
  });

  app.use((_request, response) => {
    response.status(404).type('html').send(notFoundPage());
  });

  return app;
}

/** Start the fixture on an ephemeral port. */
export async function startFixtureApp(): Promise<FixtureApp> {
  const state = new FixtureState();
  const app = buildApp(state);

  const server: Server = await new Promise((resolve, reject) => {
    // Port 0 so parallel test files never contend for a fixed port, and 127.0.0.1 rather than
    // 0.0.0.0 so a test run is not briefly serving a mutable order database to the network.
    const listening = app.listen(0, '127.0.0.1', () => {
      resolve(listening);
    });
    listening.once('error', reject);
  });

  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fixture app did not bind to a TCP port');
  }
  const { port } = address;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}
