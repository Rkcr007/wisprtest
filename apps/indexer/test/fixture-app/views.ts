import { RECENT_ORDER_COUNT, type Order } from './data.js';

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
 *
 * ## The traffic the pages generate, and why it is not decoration
 *
 * Phase 13's network observer can only learn from requests the application itself makes — the
 * crawl never submits anything. So the pages behave like the applications they stand in for:
 *
 * - `/orders` hydrates its summary from `GET /api/v2/orders?limit=50`. Fifty real records are
 *   where the distributions, the enum vocabularies and every derived rule come from.
 * - `/orders/new` populates its account picker from `GET /api/v2/accounts`. Two collections is
 *   the minimum for a referential edge to exist at all.
 * - `/orders/new` then asks the server to price the form's current contents with a **dry-run**
 *   `POST /api/v2/orders` — the create endpoint, the create payload, and an `X-Dry-Run` header
 *   that makes it compute and return without writing. Forms with a server-computed total do
 *   exactly this, and it is the only way a create request can be observed by a crawl that is
 *   forbidden from committing state. The materializer it yields is recorded *unverified*;
 *   proving it can really create a record is Phase 15's job.
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
      fieldset { margin: 0.8rem 0; }
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
    .slice(0, RECENT_ORDER_COUNT)
    .map(
      (order) => `
      <tr>
        <td>${order.reference}</td>
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
       <p id="orders-summary">Loading the full ledger…</p>
       <table>
         <thead>
           <tr><th>Reference</th><th>Customer</th><th>Amount</th><th>Status</th><th>Actions</th></tr>
         </thead>
         <tbody>${rows}</tbody>
       </table>
     </section>
     <script>
       // Table hydration. The four server-rendered rows are the recent ones; the ledger the
       // observers learn from is the full fifty, and it arrives over the API like it would in
       // any application with more rows than fit on a page.
       fetch('/api/v2/orders?limit=50')
         .then((response) => response.json())
         .then((body) => {
           document.getElementById('orders-summary').textContent =
             body.data.length + ' orders on file.';
         })
         .catch(() => {
           document.getElementById('orders-summary').textContent = 'Ledger unavailable.';
         });
     </script>`,
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
         <dt>Lines</dt><dd>${String(order.lines.length)}</dd>
       </dl>
       <form method="post" action="/orders/${String(order.id)}/approve">
         <button type="submit" data-testid="order-approve">Approve order</button>
       </form>
       <a href="/orders" data-testid="order-back">Back to orders</a>
       <p id="order-freshness">Checking for updates…</p>
     </section>
     <script>
       // A detail page re-reading its own record. Ordinary behaviour, and the reason the API
       // materializer ends up with a read-back path: verifying that a create really created
       // something means knowing the request that fetches one back.
       fetch('/api/v2/orders/${String(order.id)}')
         .then((response) => response.json())
         .then((body) => {
           document.getElementById('order-freshness').textContent =
             'Last updated ' + body.data.createdAt;
         })
         .catch(() => {
           document.getElementById('order-freshness').textContent = 'Update check failed.';
         });
     </script>`,
  );
}

/**
 * The create form.
 *
 * Every control carries the attributes the form observer is specified to read — `required`,
 * `pattern`, `min`, `maxlength`, and a `<select>`'s options — because a form that declares none
 * of them would let an observer pass by reading nothing. The line-item controls use the
 * conventional `group[index][member]` naming that Express, Rails and PHP all parse, which is how
 * a repeatable group is recognised without knowing anything about this application.
 */
export function newOrderPage(): string {
  const lineRow = (index: number): string => `
       <fieldset aria-label="Line item ${String(index + 1)}">
         <legend>Line ${String(index + 1)}</legend>
         <label for="line-${String(index)}-sku">Item code</label>
         <input id="line-${String(index)}-sku" name="lines[${String(index)}][sku]" type="text"
                pattern="SKU-[0-9]{3}" maxlength="10" />

         <label for="line-${String(index)}-quantity">Quantity</label>
         <input id="line-${String(index)}-quantity" name="lines[${String(index)}][quantity]"
                type="number" min="1" max="999" />

         <label for="line-${String(index)}-amount">Line amount</label>
         <input id="line-${String(index)}-amount" name="lines[${String(index)}][amount]"
                type="number" min="0" step="0.01" />
       </fieldset>`;

  return layout(
    'Northwind — New order',
    `<h1>New order</h1>
     <form method="post" action="/orders" aria-label="Create order">
       <label for="customer">Customer name</label>
       <input id="customer" name="customer" type="text" required maxlength="80" />

       <label for="account">Account</label>
       <select id="account" name="accountId" required>
         <option value="">Choose an account</option>
       </select>

       <label for="po-number">Purchase order number</label>
       <input id="po-number" name="poNumber" type="text" pattern="PO-[0-9]{4}" maxlength="7"
              required />

       <label for="amount">Order amount</label>
       <input id="amount" name="amount" type="number" min="0" step="0.01" required />

       <label for="status">Status</label>
       <select id="status" name="status">
         <option value="pending">Pending</option>
         <option value="approved">Approved</option>
         <option value="shipped">Shipped</option>
         <option value="cancelled">Cancelled</option>
       </select>

       <label for="terms">Payment terms</label>
       <select id="terms" name="terms">
         <option value="net15">Net 15</option>
         <option value="net30">Net 30</option>
         <option value="net60">Net 60</option>
       </select>

       <label for="notes">Notes</label>
       <textarea id="notes" name="notes" maxlength="500"></textarea>

${lineRow(0)}
${lineRow(1)}

       <p>
         <button type="submit" data-testid="order-create">Create order</button>
         <button type="button" data-testid="order-reset-hint">Clear the form</button>
       </p>
     </form>
     <p id="price-preview">Add line items to see a total.</p>
     <script>
       // Populate the account picker, then ask the server to price the form. The pricing call is
       // the create endpoint with the create payload and X-Dry-Run set: the server computes the
       // derived total and returns it without writing anything.
       fetch('/api/v2/accounts')
         .then((response) => response.json())
         .then((body) => {
           const select = document.getElementById('account');
           for (const account of body.data) {
             const option = document.createElement('option');
             option.value = account.id;
             option.textContent = account.name;
             select.append(option);
           }
           return fetch('/api/v2/orders', {
             method: 'POST',
             headers: { 'content-type': 'application/json', 'x-dry-run': '1' },
             body: JSON.stringify({
               accountId: body.data[0] ? body.data[0].id : '',
               customer: '',
               po_number: '',
               status: 'pending',
               terms: 'net30',
               notes: '',
               lines: [{ sku: '', quantity: 1, amount: 0 }],
             }),
           });
         })
         .then((response) => response.json())
         .then((preview) => {
           document.getElementById('price-preview').textContent =
             'Total: ' + preview.amount.toFixed(2);
         })
         .catch(() => {
           document.getElementById('price-preview').textContent = 'Pricing unavailable.';
         });
     </script>`,
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
