import type { ScopedQuery } from 'protocol';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, resolveContext } from './config.js';
import { computeFingerprint } from './fingerprint.js';
import { resolve } from './resolve.js';
import { scoreCandidate, scoreCandidateDetailed } from './score.js';
import { structuralHash } from './structural-hash.js';
import { at, candidate, many, one, recordFor, render } from './testing.js';

/**
 * The seven scenarios docs/BUILD-PLAN.md Phase 2 names, each asserted on scores and on the
 * decision that follows from them — not on "it returned something".
 *
 * Each is written the way it actually happens: index a page, mutate it the way a real change
 * would, and score the live DOM against what memory recorded. The drift under test is the
 * difference between those two moments.
 */

const STATE = '0f'.repeat(32);

function query(
  targetPhrase: string,
  keys: readonly string[],
  overrides: Partial<ScopedQuery> = {},
): ScopedQuery {
  return {
    verb: 'click',
    targetPhrase,
    constraints: [],
    stateFingerprint: STATE,
    candidateElementKeys: [...keys],
    ...overrides,
  };
}

const ORDERS_PAGE = `
  <main>
    <nav aria-label="Primary"><a href="/orders">Orders</a></nav>
    <section aria-label="Orders">
      <table>
        <tr><td><button data-testid="approve-1841">Approve</button></td></tr>
        <tr><td><button data-testid="approve-1842">Approve</button></td></tr>
      </table>
      <button data-testid="export">Export</button>
    </section>
  </main>
`;

describe('scenario: exact match', () => {
  it('scores 1 and resolves with high confidence when nothing has changed', () => {
    const root = render(ORDERS_PAGE);
    const exportButton = one(root, '[data-testid=export]');
    const record = recordFor(exportButton, 'orders.toolbar.export', 1);

    expect(scoreCandidate(record.fingerprint, exportButton)).toBe(1);

    const result = resolve(query('export', ['orders.toolbar.export']), [
      candidate(record, exportButton),
    ]);

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.elementKey).toBe('orders.toolbar.export');
    expect(result.elementId).toBe(record.id);
    expect(result.confidence).toBe(1);
    expect(result.tier).toBe('T0');
  });
});

describe('scenario: renamed button', () => {
  it('loses the name signal but keeps enough from the other six to still resolve', () => {
    const root = render(ORDERS_PAGE);
    const exportButton = one(root, '[data-testid=export]');
    const record = recordFor(exportButton, 'orders.toolbar.export', 1);

    // The application relabels the control. Its testid, role, position and ancestry are all
    // unchanged — which is exactly the case fingerprinting exists to survive.
    exportButton.textContent = 'Download CSV';

    const detail = scoreCandidateDetailed(record.fingerprint, exportButton, resolveContext());
    expect(detail.signals.accessibleName).toBe(0);
    expect(detail.signals.textShingle).toBe(0);
    expect(detail.signals.stableAttributes).toBe(1);
    expect(detail.signals.role).toBe(1);

    // 0.25 + 0.07 of the weight is lost out of a 0.95 denominator (geometry is inapplicable).
    expect(detail.score).toBeCloseTo((0.95 - 0.25 - 0.07) / 0.95, 6);
    expect(detail.score).toBeGreaterThan(0.6);

    // And the tester asking for it by its *new* name still resolves, because affinity is
    // measured against the live name while integrity only discounts.
    const result = resolve(query('download csv', ['orders.toolbar.export']), [
      candidate(record, exportButton),
    ]);
    expect(result.outcome).toBe('resolved');
  });

  it('ranks a rename above an unrelated control', () => {
    const root = render(ORDERS_PAGE);
    const exportButton = one(root, '[data-testid=export]');
    const link = one(root, 'nav a');
    const record = recordFor(exportButton, 'orders.toolbar.export', 1);

    exportButton.textContent = 'Download CSV';

    expect(scoreCandidate(record.fingerprint, exportButton)).toBeGreaterThan(
      scoreCandidate(record.fingerprint, link),
    );
  });
});

describe('scenario: moved element', () => {
  it('keeps a high score when an element moves within its landmark', () => {
    const root = render(ORDERS_PAGE);
    const section = one(root, 'section');
    const exportButton = one(root, '[data-testid=export]');
    const record = recordFor(exportButton, 'orders.toolbar.export', 1);

    // Moved to the top of the same region: same ancestry, different ordinal.
    section.insertBefore(exportButton, section.firstChild);

    const detail = scoreCandidateDetailed(record.fingerprint, exportButton, resolveContext());
    expect(detail.signals.landmarkPath).toBe(1);
    expect(detail.signals.stableAttributes).toBe(1);
    expect(detail.score).toBeGreaterThan(0.9);
  });

  it('costs the landmark signal when an element moves to a different region', () => {
    const root = render(`
      <main>
        <section aria-label="Orders"><button data-testid="export">Export</button></section>
        <section aria-label="Invoices"></section>
      </main>
    `);
    const exportButton = one(root, '[data-testid=export]');
    const record = recordFor(exportButton, 'orders.toolbar.export', 1);

    const invoices = many(root, 'section', 2)[1];
    if (invoices === undefined) throw new Error('fixture');
    invoices.append(exportButton);

    const detail = scoreCandidateDetailed(record.fingerprint, exportButton, resolveContext());
    expect(detail.signals.landmarkPath).toBeCloseTo(0.5, 6);
    // Still resolvable — a testid plus an unchanged role and name is strong evidence — but the
    // score has visibly dropped, which is what feeds the stability metric.
    expect(detail.score).toBeLessThan(1);
    expect(detail.score).toBeGreaterThan(0.85);
  });
});

describe('scenario: reordered list', () => {
  it('keeps each row matched to itself when the list is reversed', () => {
    const root = render(`
      <main><ul>
        <li><button data-testid="row-a">Acme Industrial</button></li>
        <li><button data-testid="row-b">Northwind Trading</button></li>
        <li><button data-testid="row-c">Contoso Supply</button></li>
      </ul></main>
    `);
    const buttons = many(root, 'button', 3);
    const records = buttons.map((button, index) =>
      recordFor(button, `orders.row.r${String(index)}`, index),
    );

    const list = one(root, 'ul');
    for (const item of [...list.children].reverse()) list.append(item);

    // Every row still scores highest against itself. Ordinal moved, so nothing scores 1 — but
    // the identity is unambiguous, which is what "breaks ties in lists" has to mean.
    for (const [index, record] of records.entries()) {
      const self = buttons[index];
      if (self === undefined) throw new Error('fixture');

      const scores = buttons.map((button) => scoreCandidate(record.fingerprint, button));
      const best = Math.max(...scores);
      expect(scores[index]).toBe(best);
      expect(scores.filter((score) => score === best)).toHaveLength(1);
    }
  });

  it('resolves the right row by name after a reorder', () => {
    const root = render(`
      <main><ul>
        <li><button data-testid="row-a">Acme Industrial</button></li>
        <li><button data-testid="row-b">Northwind Trading</button></li>
      </ul></main>
    `);
    const buttons = many(root, 'button', 2);
    const records = buttons.map((button, index) =>
      recordFor(button, `orders.row.r${String(index)}`, index),
    );

    const list = one(root, 'ul');
    list.append(at([...list.children], 0));

    const result = resolve(
      query('northwind trading', ['orders.row.r0', 'orders.row.r1']),
      buttons.map((button, index) => candidate(at(records, index), button)),
    );

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.elementKey).toBe('orders.row.r1');
  });
});

describe('scenario: framework-regenerated ids', () => {
  it('ignores a regenerated id entirely, so a re-render costs nothing', () => {
    const root = render(`<main><button id=":r1:" class="css-1x2y3z">Approve order</button></main>`);
    const button = one(root, 'button');
    const record = recordFor(button, 'orders.detail.approve', 1);

    // Neither the React `useId` nor the Emotion class was ever trusted, so regenerating them is
    // invisible to the fingerprint.
    expect(record.fingerprint.stableAttributes).toEqual({});

    button.setAttribute('id', ':r42:');
    button.setAttribute('class', 'css-9z8y7x');

    expect(scoreCandidate(record.fingerprint, button)).toBe(1);
  });

  it('would have been broken by trusting the id — the same element with a real id keeps it', () => {
    const root = render(`<main><button id="approve-order">Approve order</button></main>`);
    const button = one(root, 'button');
    const record = recordFor(button, 'orders.detail.approve', 1);

    expect(record.fingerprint.stableAttributes).toEqual({ id: 'approve-order' });

    button.setAttribute('id', 'reject-order');
    expect(scoreCandidate(record.fingerprint, button)).toBeLessThan(1);
  });
});

describe('scenario: ambiguous duplicates', () => {
  const AMBIGUOUS = `
    <main><section aria-label="Orders"><table>
      <tr><td><button>Approve</button></td></tr>
      <tr><td><button>Approve</button></td></tr>
    </table></section></main>
  `;

  it('refuses to pick between two identical controls', () => {
    const root = render(AMBIGUOUS);
    const buttons = many(root, 'button', 2);
    const records = buttons.map((button, index) =>
      recordFor(button, `orders.row.approve${String(index)}`, index),
    );

    const result = resolve(
      query('approve', ['orders.row.approve0', 'orders.row.approve1']),
      buttons.map((button, index) => candidate(at(records, index), button)),
    );

    expect(result.outcome).toBe('ambiguous');
    if (result.outcome !== 'ambiguous') return;
    expect(result.candidates).toHaveLength(2);
    // Ranked, and genuinely tied — which is precisely why it must not pick.
    expect(result.candidates[0]?.confidence).toBeCloseTo(result.candidates[1]?.confidence ?? 0, 6);
  });

  it('resolves once the tester supplies an ordinal', () => {
    const root = render(AMBIGUOUS);
    const buttons = many(root, 'button', 2);
    const records = buttons.map((button, index) =>
      recordFor(button, `orders.row.approve${String(index)}`, index),
    );

    const result = resolve(
      query('approve', ['orders.row.approve0', 'orders.row.approve1'], {
        constraints: [{ kind: 'ordinal', index: 2 }],
      }),
      buttons.map((button, index) => candidate(at(records, index), button)),
    );

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.elementKey).toBe('orders.row.approve1');
  });

  it('resolves when a `within` constraint separates the duplicates', () => {
    const root = render(`
      <main>
        <section aria-label="Orders"><button>Approve</button></section>
        <section aria-label="Invoices"><button>Approve</button></section>
      </main>
    `);
    const buttons = many(root, 'button', 2);
    const records = buttons.map((button, index) =>
      recordFor(button, `x.row.approve${String(index)}`, index),
    );

    const result = resolve(
      query('approve', ['x.row.approve0', 'x.row.approve1'], {
        constraints: [{ kind: 'within', landmark: 'region:invoices' }],
      }),
      buttons.map((button, index) => candidate(at(records, index), button)),
    );

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.elementKey).toBe('x.row.approve1');
  });
});

describe('scenario: full re-render where only structure changed', () => {
  const BEFORE = `
    <main>
      <section aria-label="Orders">
        <button data-testid="approve">Approve</button>
        <button data-testid="export">Export</button>
      </section>
    </main>
  `;

  it('leaves the structural hash unchanged when only data changed', () => {
    const before = structuralHash(one(render(BEFORE), 'main'));

    const after = structuralHash(
      one(
        render(`
          <main>
            <section aria-label="Orders">
              <button data-testid="approve">Approve order 4903</button>
              <button data-testid="export">Export</button>
            </section>
          </main>
        `),
        'main',
      ),
    );

    expect(after).toBe(before);
  });

  it('leaves the structural hash unchanged after a pure restyle', () => {
    const before = structuralHash(one(render(BEFORE), 'main'));

    const after = structuralHash(
      one(
        render(`
          <main class="layout-v2">
            <section aria-label="Orders" class="Panel_root__9fx1a" style="gap:8px">
              <button data-testid="approve" class="Button_primary__2ab3c">Approve</button>
              <button data-testid="export" class="Button_ghost__11ff2">Export</button>
            </section>
          </main>
        `),
        'main',
      ),
    );

    expect(after).toBe(before);
  });

  it('changes the structural hash when a control is added', () => {
    const before = structuralHash(one(render(BEFORE), 'main'));

    const after = structuralHash(
      one(
        render(`
          <main>
            <section aria-label="Orders">
              <button data-testid="approve">Approve</button>
              <button data-testid="reject">Reject</button>
              <button data-testid="export">Export</button>
            </section>
          </main>
        `),
        'main',
      ),
    );

    expect(after).not.toBe(before);
  });

  it('changes the structural hash when nodes are reparented but not added', () => {
    // The nesting terminator earns its keep here: the same nodes in the same document order,
    // differing only in depth, must not flatten to the same signature.
    const flat = structuralHash(one(render(`<main><a href="/x"></a><span></span></main>`), 'main'));
    const nested = structuralHash(
      one(render(`<main><a href="/x"><span></span></a></main>`), 'main'),
    );

    expect(nested).not.toBe(flat);
  });

  it('changes the structural hash when an input changes type', () => {
    const before = structuralHash(
      one(render(`<form><input type="text" name="q" /></form>`), 'form'),
    );
    const after = structuralHash(
      one(render(`<form><input type="date" name="q" /></form>`), 'form'),
    );

    expect(after).not.toBe(before);
  });

  it('survives a re-render that regenerates every framework id', () => {
    const before = structuralHash(
      one(render(`<main><button id=":r1:" data-testid="approve">Approve</button></main>`), 'main'),
    );
    const after = structuralHash(
      one(render(`<main><button id=":r99:" data-testid="approve">Approve</button></main>`), 'main'),
    );

    expect(after).toBe(before);
  });

  it('produces a hash in the encoding the contract requires', () => {
    expect(structuralHash(one(render(BEFORE), 'main'))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('still resolves every element after a structure-only re-render', () => {
    const root = render(BEFORE);
    const approve = one(root, '[data-testid=approve]');
    const record = recordFor(approve, 'orders.detail.approve', 1);

    // Wrapped in a new layout div — the kind of change a component refactor produces. The
    // wrapper is not a landmark, so ancestry is unchanged and the element still scores 1.
    const rerendered = render(`
      <main>
        <section aria-label="Orders">
          <div class="Toolbar_root__a1b2">
            <button data-testid="approve">Approve</button>
            <button data-testid="export">Export</button>
          </div>
        </section>
      </main>
    `);
    const live = one(rerendered, '[data-testid=approve]');

    expect(scoreCandidate(record.fingerprint, live)).toBe(1);
    expect(structuralHash(one(rerendered, 'main'))).not.toBe(
      structuralHash(one(render(BEFORE), 'main')),
    );
  });
});

describe('the threshold and margin are what stop a guess', () => {
  it('escalates rather than picking when the lead is inside the margin', () => {
    expect(DEFAULT_CONFIG.resolutionMargin).toBeGreaterThan(0);

    const root = render(`
      <main><section aria-label="Orders">
        <button>Approve order</button>
        <button>Approve order now</button>
      </section></main>
    `);
    const buttons = many(root, 'button', 2);
    const records = buttons.map((button, index) =>
      recordFor(button, `orders.row.a${String(index)}`, index),
    );
    const scoped = buttons.map((button, index) => candidate(at(records, index), button));
    const utterance = query('approve order', ['orders.row.a0', 'orders.row.a1']);

    // Identical inputs, and the margin alone decides. The winner clears the threshold either
    // way; what changes is whether a 0.2 lead counts as a decision or as a near-tie.
    const wideMargin = resolve(utterance, scoped, {
      context: { config: { resolutionMargin: 0.25 } },
    });
    expect(wideMargin.outcome).toBe('ambiguous');

    const narrowMargin = resolve(utterance, scoped, {
      context: { config: { resolutionMargin: 0.05 } },
    });
    expect(narrowMargin.outcome).toBe('resolved');
    if (narrowMargin.outcome !== 'resolved') return;
    expect(narrowMargin.elementKey).toBe('orders.row.a0');
    expect(narrowMargin.confidence).toBeGreaterThanOrEqual(DEFAULT_CONFIG.resolutionThreshold);
  });

  it('never returns a resolved outcome below the configured threshold', () => {
    const root = render(`<main><button data-testid="export">Export</button></main>`);
    const button = one(root, 'button');
    const record = recordFor(button, 'orders.toolbar.export', 1);

    const result = resolve(
      query('export', ['orders.toolbar.export']),
      [candidate(record, button)],
      {
        context: { config: { resolutionThreshold: 1.01 } },
      },
    );

    expect(result.outcome).not.toBe('resolved');
  });
});

describe('PII never reaches a fingerprint', () => {
  it('redacts the accessible name before storing or hashing it', () => {
    const root = render(`<main><button>Email priya.sharma@acme.com about $46,200</button></main>`);
    const fingerprint = computeFingerprint(one(root, 'button'));

    expect(fingerprint.accessibleNameRedacted).toBe('Email [email] about [amount]');
    expect(fingerprint.accessibleNameRedacted).not.toContain('priya');
    expect(fingerprint.accessibleNameRedacted).not.toContain('46,200');
  });

  it('hashes the redacted name, not the raw one', () => {
    // Hashing the raw name would be worse than storing it: a digest of a customer's address is
    // still a lookup key for that address, and it would look safe.
    const withPii = computeFingerprint(
      one(render(`<button>Contact priya@acme.com</button>`), 'button'),
    );
    const withOther = computeFingerprint(
      one(render(`<button>Contact daniel@northwind.co</button>`), 'button'),
    );

    expect(withPii.accessibleNameHash).toBe(withOther.accessibleNameHash);
  });

  it('redacts text before shingling it', () => {
    const withPii = computeFingerprint(one(render(`<div id="a">Owner priya@acme.com</div>`), '#a'));
    const withOther = computeFingerprint(
      one(render(`<div id="a">Owner daniel@northwind.co</div>`), '#a'),
    );

    expect(withPii.textShingleHash).toBe(withOther.textShingleHash);
  });

  it('redacts landmark names in the ancestry path', () => {
    const root = render(`
      <main><section aria-label="Orders for priya@acme.com">
        <button>Approve</button>
      </section></main>
    `);
    const fingerprint = computeFingerprint(one(root, 'button'));

    expect(fingerprint.landmarkPath).toEqual(['main', 'region:orders for [email]']);
  });
});
