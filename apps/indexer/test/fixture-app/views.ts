import type { Order } from './data.js';

/**
 * The fixture application's HTML.
 *
 * Written the way a competent enterprise application is written, because that is what makes it a
 * useful fixture: landmarks, labelled controls, a real table with headers, and `data-testid`
 * attributes on the controls that matter. A crawl over markup with no accessible names would
 * prove that the crawler runs, not that it learns anything.
 *
 * Two things are here specifically to be *not* activated: the delete button on each row, which
 * the crawl's never-interact list covers, and the create form's submit button, which the
 * form-submitter rule covers. Both perform real state changes if they are ever pressed, and the
 * e2e suite checks that they were not.
 */

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; }
      nav, main { padding: 1rem; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; }
      .danger { color: #a11; }
      label { display: block; margin: 0.6rem 0 0.2rem; }
    </style>
  </head>
  <body>
    <nav aria-label="Primary">
      <a href="/">Home</a>
      <a href="/orders">Orders</a>
      <a href="/orders/new">New order</a>
      <a href="/settings">Settings</a>
    </nav>
    <main>${body}</main>
  </body>
</html>`;
}

export function homePage(orderCount: number): string {
  return layout(
    'Northwind — Home',
    `<h1>Northwind operations</h1>
     <p>${String(orderCount)} orders in the system.</p>
     <section aria-label="Shortcuts">
       <a href="/orders" data-testid="home-open-orders">Open orders</a>
       <a href="/settings" data-testid="home-open-settings">Open settings</a>
     </section>`,
  );
}

export function ordersPage(orders: readonly Order[]): string {
  const rows = orders
    .map(
      (order) => `
      <tr>
        <td>${String(order.id)}</td>
        <td>${order.customer}</td>
        <td>${order.amount.toFixed(2)}</td>
        <td>${order.status}</td>
        <td>
          <a href="/orders/${String(order.id)}" data-testid="order-view-${String(order.id)}">View</a>
          <form method="post" action="/orders/${String(order.id)}/delete" style="display:inline">
            <button type="submit" class="danger" data-testid="order-delete">Delete</button>
          </form>
        </td>
      </tr>`,
    )
    .join('');

  return layout(
    'Northwind — Orders',
    `<h1>Orders</h1>
     <section aria-label="Orders">
       <a href="/orders?status=pending" data-testid="orders-filter-pending">Show pending only</a>
       <table>
         <thead>
           <tr><th>Reference</th><th>Customer</th><th>Amount</th><th>Status</th><th>Actions</th></tr>
         </thead>
         <tbody>${rows}</tbody>
       </table>
     </section>`,
  );
}

export function orderDetailPage(order: Order): string {
  return layout(
    `Northwind — Order ${String(order.id)}`,
    `<h1>Order ${String(order.id)}</h1>
     <section aria-label="Order detail">
       <dl>
         <dt>Customer</dt><dd>${order.customer}</dd>
         <dt>Amount</dt><dd>${order.amount.toFixed(2)}</dd>
         <dt>Status</dt><dd>${order.status}</dd>
         <dt>Lines</dt><dd>${String(order.lines)}</dd>
       </dl>
       <form method="post" action="/orders/${String(order.id)}/approve">
         <button type="submit" data-testid="order-approve">Approve order</button>
       </form>
       <a href="/orders" data-testid="order-back">Back to orders</a>
     </section>`,
  );
}

export function newOrderPage(): string {
  return layout(
    'Northwind — New order',
    `<h1>New order</h1>
     <form method="post" action="/orders" aria-label="Create order">
       <label for="customer">Customer name</label>
       <input id="customer" name="customer" type="text" required maxlength="80" />

       <label for="amount">Order amount</label>
       <input id="amount" name="amount" type="number" min="0" step="0.01" required />

       <label for="status">Status</label>
       <select id="status" name="status">
         <option value="pending">Pending</option>
         <option value="approved">Approved</option>
         <option value="shipped">Shipped</option>
       </select>

       <p>
         <button type="submit" data-testid="order-create">Create order</button>
         <button type="button" data-testid="order-reset-hint">Clear the form</button>
       </p>
     </form>`,
  );
}

export function settingsPage(): string {
  return layout(
    'Northwind — Settings',
    `<h1>Settings</h1>
     <section aria-label="Notifications">
       <form method="post" action="/settings" aria-label="Notification settings">
         <label for="digest">Daily digest recipient</label>
         <input id="digest" name="digest" type="email" value="ops@northwind.example" />
         <button type="submit" data-testid="settings-save">Save settings</button>
       </form>
     </section>
     <section aria-label="Danger zone">
       <button type="button" class="danger" data-testid="settings-purge">Purge all orders</button>
     </section>
     <script>
       // A destructive control that is not a form submitter: pressing it deletes every order
       // through fetch. Nothing about its markup marks it as dangerous, which is exactly why the
       // never-interact list exists — and why this fixture makes the consequence real rather than
       // simulated. If a crawl ever activates it, the mutation log says so.
       document.querySelector('[data-testid="settings-purge"]').addEventListener('click', () => {
         void fetch('/settings/purge', { method: 'POST' });
       });
     </script>`,
  );
}

export function notFoundPage(): string {
  return layout('Northwind — Not found', '<h1>Not found</h1><a href="/">Back home</a>');
}
