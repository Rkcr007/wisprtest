import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CompositionPlan } from './data.js';
import { FIXTURES } from './fixtures.js';
import { type Result, WisprError, WisprErrorCode, resultOf } from './errors.js';

describe('WisprErrorCode', () => {
  it('lists exactly the codes the WisprError union discriminates on', () => {
    // Two lists that must agree. Without this test, adding a variant without its code — or
    // removing a variant and leaving the code behind — is invisible until something switches
    // exhaustively on one of them and silently stops covering a case.
    const fromUnion = WisprError.options.map((option) => option.shape.code.value).sort();

    expect([...WisprErrorCode.options].sort()).toEqual(fromUnion);
  });

  it('has a valid fixture for every code', () => {
    const fixture = FIXTURES.WisprError;
    if (fixture === undefined) throw new Error('no WisprError fixture');

    const covered = fixture.valid.map((value) => WisprError.parse(value).code).sort();
    expect(covered).toEqual([...WisprErrorCode.options].sort());
  });
});

describe('WisprError', () => {
  it('declares retryability on every variant rather than leaving it to be inferred', () => {
    for (const option of WisprError.options) {
      expect(Object.keys(option.shape)).toContain('retryable');
    }
  });

  it('carries both colliding constraints when a constraint set is unsatisfiable', () => {
    // docs/TEST-DATA-ENGINE.md § 7: "Report the conflict in plain language; never silently drop
    // a constraint." Naming one side of a collision is the same as dropping the other.
    const error = WisprError.parse({
      code: 'constraint_unsatisfiable',
      message: 'An invoice cannot be both paid and overdue.',
      retryable: false,
      entity: 'Invoice',
      conflicting: [
        { kind: 'equals', field: 'status', value: 'Paid' },
        { kind: 'predicate', name: 'overdue' },
      ],
    });

    expect(error.code).toBe('constraint_unsatisfiable');
    if (error.code !== 'constraint_unsatisfiable') return;
    expect(error.conflicting).toHaveLength(2);
    expect(error.message).not.toBe('');
  });

  it('narrows to the fields of a single variant once the code is checked', () => {
    const error = WisprError.parse({
      code: 'rate_limited',
      message: 'Too many requests.',
      retryable: true,
      retryAfterSeconds: 30,
    });

    if (error.code !== 'rate_limited') throw new Error('unexpected code');
    // A compile-time assertion as much as a runtime one: `retryAfterSeconds` only exists on
    // this member, so this line would not typecheck if the union stopped discriminating.
    expect(error.retryAfterSeconds).toBe(30);
  });
});

describe('resultOf', () => {
  const PlanResult = resultOf(CompositionPlan);
  const plan = FIXTURES.CompositionPlan?.valid[0];

  it('parses a success envelope carrying the payload type', () => {
    const parsed: Result<z.infer<typeof CompositionPlan>> = PlanResult.parse({
      ok: true,
      value: plan,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.rootNodeId).toBe('order-1');
  });

  it('parses a failure envelope carrying a typed error', () => {
    const parsed = PlanResult.parse({
      ok: false,
      error: {
        code: 'schema_confidence_too_low',
        message: 'Too little is known about Order to create one.',
        retryable: false,
        entity: 'Order',
        confidence: 0.31,
        threshold: 0.7,
        missingFields: ['terms'],
      },
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('schema_confidence_too_low');
  });

  it('rejects an envelope that carries both a value and an error', () => {
    expect(PlanResult.safeParse({ ok: true, value: plan, error: null }).success).toBe(false);
  });

  it('rejects a success envelope whose payload is not the payload type', () => {
    expect(PlanResult.safeParse({ ok: true, value: { rootNodeId: 'order-1' } }).success).toBe(
      false,
    );
  });
});
