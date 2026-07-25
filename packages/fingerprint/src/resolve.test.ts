import type { ScopedQuery } from 'protocol';
import { describe, expect, it } from 'vitest';

import { resolve } from './resolve.js';
import { at, candidate, many, one, recordFor, render } from './testing.js';

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

const FORM = `
  <main><section aria-label="New order">
    <label for="account">Account</label>
    <input id="account" name="account" />
    <label for="po">Purchase order</label>
    <input id="po" name="po" />
    <button data-testid="submit">Create order</button>
  </section></main>
`;

describe('resolve — scoping', () => {
  it('never looks outside the query scope, even when the element was handed to it', () => {
    // The scoped candidate set is what keeps T0 inside 15 ms and what makes it accurate. A
    // resolver that quietly widened its own search would break both.
    const root = render(FORM);
    const submit = one(root, '[data-testid=submit]');
    const record = recordFor(submit, 'orders.create.submit', 1);

    const result = resolve(query('create order', []), [candidate(record, submit)]);

    expect(result.outcome).toBe('not_found');
  });

  it('scores only the candidates whose keys are in scope', () => {
    const root = render(FORM);
    const submit = one(root, '[data-testid=submit]');
    const inputs = many(root, 'input', 2);
    const submitRecord = recordFor(submit, 'orders.create.submit', 1);
    const accountRecord = recordFor(at(inputs, 0), 'orders.create.account', 2);

    const result = resolve(query('account', ['orders.create.submit']), [
      candidate(submitRecord, submit),
      candidate(accountRecord, at(inputs, 0)),
    ]);

    // "account" matches the input far better, but the input is out of scope, and the submit
    // button is too weak a match to clear the floor.
    expect(result.outcome).toBe('not_found');
  });

  it('returns not_found for an empty candidate list', () => {
    expect(resolve(query('anything', ['a.b.c']), []).outcome).toBe('not_found');
  });
});

describe('resolve — the verb narrows the target', () => {
  it('prefers the field over its label when the verb is `type`', () => {
    const root = render(FORM);
    const label = one(root, 'label[for=account]');
    const input = one(root, '#account');

    const labelRecord = recordFor(label, 'orders.create.accountlabel', 1);
    const inputRecord = recordFor(input, 'orders.create.account', 2);

    const result = resolve(
      query('account', ['orders.create.accountlabel', 'orders.create.account'], { verb: 'type' }),
      [candidate(labelRecord, label), candidate(inputRecord, input)],
    );

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.elementKey).toBe('orders.create.account');
  });

  it('leaves ranking alone for a verb that constrains nothing', () => {
    const root = render(FORM);
    const input = one(root, '#account');
    const record = recordFor(input, 'orders.create.account', 1);

    const result = resolve(query('account', ['orders.create.account'], { verb: 'check' }), [
      candidate(record, input),
    ]);

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.candidates[0]?.signalScores.verb).toBe(1);
  });

  it('discounts a target the verb cannot act on, to the point of changing the outcome', () => {
    const root = render(FORM);
    const submit = one(root, '[data-testid=submit]');
    const record = recordFor(submit, 'orders.create.submit', 1);
    const scoped = [candidate(record, submit)];

    // Same element, same phrase, perfect name match. The verb is the only difference.
    const clicked = resolve(
      query('create order', ['orders.create.submit'], { verb: 'click' }),
      scoped,
    );
    expect(clicked.outcome).toBe('resolved');
    if (clicked.outcome !== 'resolved') return;
    expect(clicked.candidates[0]?.signalScores.verb).toBe(1);

    // A button is not a typing target, so the discount drops it under the threshold — and with
    // nothing else in scope there is no ambiguity to offer, only a miss.
    const typed = resolve(
      query('create order', ['orders.create.submit'], { verb: 'type' }),
      scoped,
    );
    expect(typed.outcome).toBe('not_found');
  });
});

describe('resolve — matching by element key', () => {
  it('resolves an icon-only control with no useful name, via its key', () => {
    const root = render(`<main><button aria-label="">⋯</button></main>`);
    const button = one(root, 'button');
    const record = recordFor(button, 'orders.row.overflow', 1);

    const result = resolve(query('row overflow', ['orders.row.overflow']), [
      candidate(record, button),
    ]);

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.elementKey).toBe('orders.row.overflow');
  });
});

describe('resolve — integrity discounts but does not exclude', () => {
  it('lowers confidence for a drifted element without hiding it', () => {
    const root = render(FORM);
    const submit = one(root, '[data-testid=submit]');
    const pristine = recordFor(submit, 'orders.create.submit', 1);

    // The element drifts hard: different role, different ancestry, lost testid.
    const drifted = render(`<main><a href="/create">Create order</a></main>`);
    const live = one(drifted, 'a');

    const before = resolve(query('create order', ['orders.create.submit']), [
      candidate(pristine, submit),
    ]);
    const after = resolve(query('create order', ['orders.create.submit']), [
      candidate(pristine, live),
    ]);

    if (before.outcome !== 'resolved') throw new Error('expected the pristine case to resolve');
    if (after.outcome === 'not_found') throw new Error('a drifted element must stay visible');

    const afterConfidence = after.candidates[0]?.confidence ?? 0;
    expect(afterConfidence).toBeLessThan(before.confidence);
    expect(afterConfidence).toBeGreaterThan(0);
  });

  it('discounts by at most the integrity floor, so affinity still decides', () => {
    const root = render(FORM);
    const submit = one(root, '[data-testid=submit]');
    const record = recordFor(submit, 'orders.create.submit', 1);
    const unrelated = one(render(`<main><span></span></main>`), 'span');

    const result = resolve(query('create order', ['orders.create.submit']), [
      candidate(record, unrelated),
    ]);

    // Affinity is 0 against an unnamed span, so nothing survives the floor regardless.
    expect(result.outcome).toBe('not_found');
  });
});

describe('resolve — ordinal constraints', () => {
  const THREE_ROWS = `
    <main><ul>
      <li><button>Approve</button></li>
      <li><button>Approve</button></li>
      <li><button>Approve</button></li>
    </ul></main>
  `;

  function threeRows() {
    const root = render(THREE_ROWS);
    const buttons = many(root, 'button', 3);
    const records = buttons.map((button, index) =>
      recordFor(button, `orders.row.approve${String(index)}`, index),
    );
    return {
      keys: records.map((record) => record.elementKey),
      scoped: buttons.map((button, index) => candidate(at(records, index), button)),
    };
  }

  it('indexes the shortlist one-based, as the ordinal is spoken', () => {
    const { keys, scoped } = threeRows();

    for (const [spoken, expected] of [
      [1, 'orders.row.approve0'],
      [2, 'orders.row.approve1'],
      [3, 'orders.row.approve2'],
    ] as const) {
      const result = resolve(
        query('approve', keys, { constraints: [{ kind: 'ordinal', index: spoken }] }),
        scoped,
      );
      expect(result.outcome).toBe('resolved');
      if (result.outcome !== 'resolved') continue;
      expect(result.elementKey).toBe(expected);
    }
  });

  it('reports not_found for an ordinal past the end rather than wrapping', () => {
    const { keys, scoped } = threeRows();
    const result = resolve(
      query('approve', keys, { constraints: [{ kind: 'ordinal', index: 4 }] }),
      scoped,
    );

    expect(result.outcome).toBe('not_found');
  });

  it('completes a disambiguation the resolver itself refused to make', () => {
    // The flow this exists for: resolve → ambiguous → the tester says "two" → resolve again
    // with the ordinal. Note what blocks the first call: all three rows are *identical*, so each
    // scores a perfect 1 and the threshold is easily cleared. It is the margin that refuses —
    // there is no lead at all — and the ordinal is the only thing that can break the tie.
    const { keys, scoped } = threeRows();

    const first = resolve(query('approve', keys), scoped);
    expect(first.outcome).toBe('ambiguous');
    if (first.outcome !== 'ambiguous') return;
    expect(first.candidates.map((entry) => entry.confidence)).toEqual([1, 1, 1]);

    const second = resolve(
      query('approve', keys, { constraints: [{ kind: 'ordinal', index: 2 }] }),
      scoped,
    );
    expect(second.outcome).toBe('resolved');
    if (second.outcome !== 'resolved') return;
    expect(second.elementKey).toBe('orders.row.approve1');
    expect(second.candidates).toHaveLength(1);
  });
});

describe('resolve — the result payload', () => {
  it('reports the tier the caller says it is running as', () => {
    const root = render(FORM);
    const submit = one(root, '[data-testid=submit]');
    const record = recordFor(submit, 'orders.create.submit', 1);
    const scoped = [candidate(record, submit)];

    for (const tier of ['T0', 'T1', 'T2'] as const) {
      expect(resolve(query('create order', ['orders.create.submit']), scoped, { tier }).tier).toBe(
        tier,
      );
    }
  });

  it('measures latency with the supplied clock', () => {
    const root = render(FORM);
    const submit = one(root, '[data-testid=submit]');
    const record = recordFor(submit, 'orders.create.submit', 1);

    let tick = 100;
    const result = resolve(
      query('create order', ['orders.create.submit']),
      [candidate(record, submit)],
      { now: () => (tick += 7) },
    );

    expect(result.latencyMs).toBe(7);
  });

  it('reports a non-negative latency with the real clock', () => {
    const root = render(FORM);
    const submit = one(root, '[data-testid=submit]');
    const record = recordFor(submit, 'orders.create.submit', 1);

    const result = resolve(query('create order', ['orders.create.submit']), [
      candidate(record, submit),
    ]);

    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('carries the element id from memory, since a DOM node has none', () => {
    const root = render(FORM);
    const submit = one(root, '[data-testid=submit]');
    const record = recordFor(submit, 'orders.create.submit', 7);

    const result = resolve(query('create order', ['orders.create.submit']), [
      candidate(record, submit),
    ]);

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.elementId).toBe(record.id);
  });

  it('returns candidates ranked best first', () => {
    const root = render(`
      <main><section aria-label="Orders">
        <button>Approve order</button>
        <button>Approve</button>
        <button>Approve order now please</button>
      </section></main>
    `);
    const buttons = many(root, 'button', 3);
    const records = buttons.map((button, index) =>
      recordFor(button, `orders.row.b${String(index)}`, index),
    );

    const result = resolve(
      query(
        'approve order',
        records.map((record) => record.elementKey),
      ),
      buttons.map((button, index) => candidate(at(records, index), button)),
    );

    if (result.outcome === 'not_found') throw new Error('expected candidates');
    const confidences = result.candidates.map((entry) => entry.confidence);
    expect(confidences).toEqual([...confidences].sort((a, b) => b - a));
  });

  it('drops candidates below the floor rather than padding the list', () => {
    const root = render(`
      <main><section aria-label="Orders">
        <button>Approve order</button>
        <button>Print packing slip</button>
      </section></main>
    `);
    const buttons = many(root, 'button', 2);
    const records = buttons.map((button, index) =>
      recordFor(button, `orders.row.b${String(index)}`, index),
    );

    const result = resolve(
      query(
        'approve order',
        records.map((record) => record.elementKey),
      ),
      buttons.map((button, index) => candidate(at(records, index), button)),
    );

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.candidates).toHaveLength(1);
  });

  it('reports a single weak candidate as not_found, with no candidates attached', () => {
    // `ambiguous` requires at least two candidates, and one weak guess is not an ambiguity —
    // there is nothing to choose between. Offering it anyway would be the guess the resolver is
    // not allowed to make.
    const root = render(`<main><button>Print packing slip</button></main>`);
    const button = one(root, 'button');
    const record = recordFor(button, 'orders.row.print', 1);

    const result = resolve(query('approve the order', ['orders.row.print']), [
      candidate(record, button),
    ]);

    expect(result.outcome).toBe('not_found');
    if (result.outcome !== 'not_found') return;
    expect(result.candidates).toEqual([]);
  });
});
