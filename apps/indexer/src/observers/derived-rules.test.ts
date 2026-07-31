import { describe, expect, it } from 'vitest';

import { inferDerivedRules } from './derived-rules.js';
import type { JsonRecord } from './types.js';

/**
 * Derived-rule inference, and the three ways it can be wrong.
 *
 * A wrong rule is the most expensive mistake this observer can make. The solver evaluates rules
 * *last* and overwrites whatever the sampler produced, so a rule that does not really hold
 * silently corrupts every composed record of that entity — and it does so invisibly, because the
 * record still looks plausible.
 */

/** `n` records where `total` really is the sum of the group, plus whatever else is asked for. */
function orders(count: number, extra: (index: number) => JsonRecord = () => ({})): JsonRecord[] {
  return Array.from({ length: count }, (_unused, index) => {
    const lines = Array.from({ length: 1 + (index % 3) }, (_line, position) => ({
      amount: 100 + index * 10 + position,
      quantity: 1 + position,
    }));
    return {
      id: index,
      total: lines.reduce((sum, line) => sum + line.amount, 0),
      lines,
      ...extra(index),
    };
  });
}

describe('the hypothesis set', () => {
  it('finds a sum over a repeated group', () => {
    const found = inferDerivedRules('Order', orders(20));
    const total = found.find((rule) => rule.field === 'total');
    expect(total?.rule.rule).toEqual({ kind: 'sum', overField: 'lines', ofField: 'amount' });
  });

  it('finds count, min and max over a group', () => {
    const records = orders(20, () => ({})).map((record) => {
      const lines = record.lines as { amount: number }[];
      return {
        ...record,
        lineCount: lines.length,
        cheapest: Math.min(...lines.map((line) => line.amount)),
        dearest: Math.max(...lines.map((line) => line.amount)),
      };
    });

    const rules = new Map(inferDerivedRules('Order', records).map((r) => [r.field, r.rule.rule]));
    expect(rules.get('lineCount')).toEqual({ kind: 'count', overField: 'lines' });
    expect(rules.get('cheapest')).toEqual({ kind: 'min', overField: 'lines', ofField: 'amount' });
    expect(rules.get('dearest')).toEqual({ kind: 'max', overField: 'lines', ofField: 'amount' });
  });

  it('finds a whole-day offset between two dates', () => {
    const records = orders(20, (index) => ({
      createdAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
      dueAt: new Date(Date.UTC(2026, 0, 15 + index)).toISOString(),
    }));

    const due = inferDerivedRules('Order', records).find((rule) => rule.field === 'dueAt');
    expect(due?.rule.rule).toEqual({ kind: 'date_offset', fromField: 'createdAt', offsetDays: 14 });
  });

  it('finds a concatenation of two fields', () => {
    const records = orders(20, (index) => ({
      reference: `ORD-${String(2000 + index)}`,
      poNumber: `PO-${String(3000 + index)}`,
      label: `ORD-${String(2000 + index)} · PO-${String(3000 + index)}`,
    }));

    const label = inferDerivedRules('Order', records).find((rule) => rule.field === 'label');
    expect(label?.rule.rule).toEqual({
      kind: 'concat',
      fields: ['reference', 'poNumber'],
      separator: ' · ',
    });
  });
});

describe('what it refuses to record', () => {
  it('rejects a hypothesis with a single counterexample', () => {
    const records = orders(20);
    // One record where the total is a penny out. It is not a rule with confidence 0.95; it is a
    // coincidence with a counterexample, and the solver would overwrite a correct value with it.
    const broken = records[7];
    if (broken === undefined) throw new Error('unreachable');
    broken.total = (broken.total as number) + 0.5;

    const found = inferDerivedRules('Order', records);
    expect(found.find((rule) => rule.field === 'total')).toBeUndefined();
  });

  it('declines to generalise from too small a sample', () => {
    expect(inferDerivedRules('Order', orders(4))).toEqual([]);
  });

  it('never records two fields as derived from each other', () => {
    // Both directions hold for every record: `dueAt = createdAt + 14d` and its inverse. Storing
    // both leaves the solver with two fields each waiting on the other and nowhere to start.
    const records = orders(20, (index) => ({
      createdAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
      dueAt: new Date(Date.UTC(2026, 0, 15 + index)).toISOString(),
    }));

    const found = inferDerivedRules('Order', records);
    const temporal = found.filter((rule) => rule.rule.rule.kind === 'date_offset');
    expect(temporal).toHaveLength(1);
    expect(temporal[0]?.field).toBe('dueAt');
  });

  it('does not mistake an identifier for a date', () => {
    // `Date.parse('ORD-2001')` returns the first of January 2001, and `Date.parse('PO-3100')` a
    // date in the 32nd century. Treating either as temporal moves the column out of the string
    // pool, and the concatenation that really relates them is never found.
    const records = orders(20, (index) => ({
      reference: `ORD-${String(2000 + index)}`,
      poNumber: `PO-${String(3000 + index)}`,
      label: `ORD-${String(2000 + index)}/PO-${String(3000 + index)}`,
    }));

    const found = inferDerivedRules('Order', records);
    expect(found.some((rule) => rule.rule.rule.kind === 'date_offset')).toBe(false);
    expect(found.find((rule) => rule.field === 'label')?.rule.rule).toEqual({
      kind: 'concat',
      fields: ['reference', 'poNumber'],
      separator: '/',
    });
  });
});

describe('confidence', () => {
  it('reflects how much evidence stands behind the rule, not how often it held', () => {
    // It always held — anything less is not recorded — so confidence is a function of sample size,
    // saturating where docs/TEST-DATA-ENGINE.md § 2.3's own example does.
    const small = inferDerivedRules('Order', orders(10)).find((rule) => rule.field === 'total');
    const large = inferDerivedRules('Order', orders(80)).find((rule) => rule.field === 'total');

    expect(small?.rule.confidence).toBeCloseTo(0.2, 5);
    expect(small?.rule.sampleSize).toBe(10);
    expect(large?.rule.confidence).toBe(1);
    expect(large?.rule.sampleSize).toBe(80);
  });
});
