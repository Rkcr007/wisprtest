import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express, { type Express } from 'express';

import { FixtureState, type Order } from './data.js';
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
 */

export interface FixtureApp {
  readonly url: string;
  readonly state: FixtureState;
  close(): Promise<void>;
}

export function buildApp(state: FixtureState): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

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
