import { beforeAll, describe, expect, it } from 'vitest';

import { createScopedElementIndex, type ScopedElementIndex } from './scoped-index.js';
import { mutationRecord } from './testing.js';
import { createVisibilityTracker, type VisibilityTracker } from './visibility.js';

/**
 * The scope-recompute budget gate.
 *
 * docs/BUILD-PLAN.md Phase 7: "recomputing the scoped index after a mutation burst must stay
 * under 8ms on a page with 3000 DOM nodes. Write a benchmark test that asserts this and fails
 * the build if it regresses."
 *
 * Run by `pnpm --filter extension bench:scope`, on its own config so a latency assertion never
 * runs inside the unit suite — a timing check that fails under an unrelated CI hiccup teaches
 * people to rerun red builds.
 *
 * ## Why 8 ms is the number that matters
 *
 * The scope recompute sits between the tester finishing a word and the reticle appearing, inside
 * the 400 ms p95 speech-to-reticle budget. It is also the one step that runs on *every* mutation
 * burst rather than once per utterance, so a regression here is paid continuously, on every
 * keystroke into the application under test, whether or not anyone is speaking.
 *
 * ## What this measures, and what it does not
 *
 * It runs in happy-dom, whose DOM is implemented in JavaScript — `querySelectorAll`, `closest`
 * and `contains` are all substantially slower here than Blink's C++. A result under 8 ms in this
 * environment is therefore a **conservative upper bound**: the same work in Chrome is faster,
 * not slower. What it cannot measure is Chrome's own cost for delivering the records, which is
 * outside our code and outside the budget.
 *
 * The alternative — driving a real Chrome through Playwright — measures the right engine but
 * makes the gate depend on a browser download and on whatever else the CI machine is doing. The
 * conservative proxy is the more useful gate, and it is honest about being one.
 */

/** The budget from the build plan. */
const BUDGET_MS = 8;

const WARMUP_RUNS = 10;
const MEASURED_RUNS = 60;

/** Roughly an enterprise list screen: chrome, a filter panel, and a table that dominates. */
const TABLE_ROWS = 340;
const REPLACED_ROWS = 40;

function buildPage(document: Document): HTMLElement {
  document.body.innerHTML = `
    <header role="banner">
      <nav aria-label="Primary">
        ${range(8)
          .map((n) => `<a href="/section-${String(n)}">Section ${String(n)}</a>`)
          .join('')}
      </nav>
    </header>
    <aside role="complementary" aria-label="Filters">
      ${range(12)
        .map(
          (n) => `
            <div class="field">
              <label for="filter-${String(n)}">Filter ${String(n)}</label>
              <input id="filter-${String(n)}" name="filter-${String(n)}" />
            </div>`,
        )
        .join('')}
      <button type="button">Apply</button>
      <button type="button">Reset</button>
    </aside>
    <main>
      <section role="region" aria-label="Orders">
        <table><tbody id="rows"></tbody></table>
      </section>
    </main>
  `;

  const tbody = document.querySelector('#rows') as HTMLElement;
  tbody.replaceChildren(...range(TABLE_ROWS).map((n) => buildRow(document, n)));
  return tbody;
}

/** One table row: four cells of text and three controls. Ten nodes, near enough. */
function buildRow(document: Document, n: number): HTMLElement {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td>ORD-${String(n)}</td>
    <td>Pending</td>
    <td>2026-07-27</td>
    <td><a href="/orders/${String(n)}">View</a></td>
    <td>
      <button type="button" data-testid="approve-${String(n)}">Approve</button>
      <input type="checkbox" name="select-${String(n)}" />
    </td>
  `;
  return row;
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index] ?? 0;
}

interface Measurement {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/**
 * Time `recompute`, with `prepare` outside the clock.
 *
 * The split is the whole reason this measures anything useful. `prepare` is the *application*
 * changing its own DOM — building rows, appending them, toggling attributes. That work happens
 * whether WisprTest is attached or not, and Chrome does it natively where happy-dom does it in
 * JavaScript, so including it would measure the wrong engine doing the wrong thing. The budget is
 * on what the extension adds: turning the resulting records back into a candidate set.
 */
function measure<T>(prepare: () => T, recompute: (prepared: T) => void): Measurement {
  for (let i = 0; i < WARMUP_RUNS; i += 1) recompute(prepare());

  const samples: number[] = [];
  for (let i = 0; i < MEASURED_RUNS; i += 1) {
    const prepared = prepare();
    const started = performance.now();
    recompute(prepared);
    samples.push(performance.now() - started);
  }

  return {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: Math.max(...samples),
  };
}

function report(name: string, measurement: Measurement): void {
  process.stdout.write(
    `${JSON.stringify({
      event: 'bench.scope',
      scenario: name,
      p50_ms: Number(measurement.p50.toFixed(3)),
      p95_ms: Number(measurement.p95.toFixed(3)),
      max_ms: Number(measurement.max.toFixed(3)),
      budget_ms: BUDGET_MS,
    })}\n`,
  );
}

describe('scoped index recompute', () => {
  let tbody: HTMLElement;
  let visibility: VisibilityTracker;
  // Undefined during the index's own construction walk: the fake observer below calls back
  // synchronously, where the real one would deliver on a later frame.
  let built: ScopedElementIndex | undefined;

  function index(): ScopedElementIndex {
    if (built === undefined) throw new Error('the index was not built');
    return built;
  }

  beforeAll(() => {
    tbody = buildPage(document);

    visibility = createVisibilityTracker({
      onChange: () => built?.invalidateVisibility(),
      // Reports every element as intersecting the moment it is observed. The real observer is
      // asynchronous, so this puts *more* work inside the timed section than Chrome would —
      // the visible-set bookkeeping for a whole burst lands there rather than on a later frame.
      observerFactory: (callback) => {
        const observed = new Set<Element>();
        const observer = {
          observe(element: Element): void {
            observed.add(element);
            callback(
              [{ target: element, isIntersecting: true } as unknown as IntersectionObserverEntry],
              observer,
            );
          },
          unobserve(element: Element): void {
            observed.delete(element);
          },
          disconnect(): void {
            observed.clear();
          },
          takeRecords: (): IntersectionObserverEntry[] => [],
        } as unknown as IntersectionObserver;
        return observer;
      },
    });

    built = createScopedElementIndex({ root: document.body, visibility });
  });

  it('is measured against a page of at least 3000 nodes', () => {
    const nodes = document.body.querySelectorAll('*').length + 1;
    expect(nodes).toBeGreaterThanOrEqual(3000);
    expect(index().size).toBeGreaterThan(300);
  });

  it('stays inside 8ms when a burst replaces a block of table rows', () => {
    // The shape of an applied filter, which is the most common structural burst in the
    // applications this runs against.
    let generation = 0;
    const measurement = measure(
      () => {
        const removed = [...tbody.children].slice(0, REPLACED_ROWS);
        generation += 1;
        const added = range(REPLACED_ROWS).map((n) => buildRow(document, generation * 1000 + n));

        for (const row of removed) row.remove();
        tbody.append(...added);

        return [
          mutationRecord({
            type: 'childList',
            target: tbody,
            removedNodes: removed,
            addedNodes: added,
          }),
        ];
      },
      (records) => {
        index().applyMutations(records);
        index().candidates();
      },
    );

    report('row-replacement', measurement);
    expect(measurement.p95).toBeLessThan(BUDGET_MS);
  });

  it('stays inside 8ms for a burst of attribute changes across the table', () => {
    const rows = [...tbody.children];
    const buttons = rows
      .map((row) => row.querySelector('button'))
      .filter((button): button is HTMLButtonElement => button !== null);

    let disabled = false;
    const measurement = measure(
      () => {
        disabled = !disabled;
        for (const button of buttons) {
          if (disabled) button.setAttribute('disabled', '');
          else button.removeAttribute('disabled');
        }

        return buttons.map((button) =>
          mutationRecord({ type: 'attributes', target: button, attributeName: 'disabled' }),
        );
      },
      (records) => {
        index().applyMutations(records);
        index().candidates();
      },
    );

    report('attribute-burst', measurement);
    expect(measurement.p95).toBeLessThan(BUDGET_MS);
  });

  it('stays inside 8ms when a modal opens and closes', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Confirm approval');
    dialog.innerHTML = '<button type="button">Yes</button><button type="button">No</button>';
    document.body.append(dialog);
    index().applyMutations([
      mutationRecord({ type: 'childList', target: document.body, addedNodes: [dialog] }),
    ]);

    // The one operation that touches every registered entry rather than only what changed. It is
    // rare — a tester opens a dialog, not a hundred a second — but it must still fit the budget,
    // because it lands in the same burst as the click that opened it.
    const measurement = measure(
      () => undefined,
      () => {
        index().setScopeRoot(dialog);
        index().candidates();
        index().setScopeRoot(null);
        index().candidates();
      },
    );

    report('modal-scope', measurement);
    expect(measurement.p95).toBeLessThan(BUDGET_MS);
  });
});
