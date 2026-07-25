import { describe, expect, it } from 'vitest';

import { ActionRequest } from './runtime.js';
import { ActionClass } from './vocabulary.js';

/**
 * The reversibility taxonomy, enforced at the contract boundary.
 *
 * CLAUDE.md is unambiguous: "Speculating on a Class C action is the single worst bug this
 * product can have." Phase 10 of docs/BUILD-PLAN.md carries the release-gate test for the
 * speculation controller's *behaviour*. This file covers the layer beneath it — that an
 * ActionRequest violating the taxonomy cannot even be constructed, so a bug in the controller
 * fails loudly at the boundary instead of reaching the executor.
 */

const BASE = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  sessionId: '9c5b94b1-35ad-49bb-b118-8e8fc24abf80',
  elementId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427',
  elementKey: 'orders.detail.approve',
  payload: { verb: 'click' as const },
  tier: 'T0' as const,
  confidence: 0.99,
  stateFingerprint: '0f'.repeat(32),
  issuedAt: '2026-07-25T09:30:00.000Z',
};

function request(overrides: {
  actionClass: string;
  speculative: boolean;
  confirmed: boolean;
}): unknown {
  return { ...BASE, ...overrides };
}

describe('ActionClass', () => {
  it('is exactly the four classes in the reversibility taxonomy', () => {
    expect(ActionClass.options).toEqual(['R', 'C', 'A', 'S']);
  });
});

describe('ActionRequest — speculative execution', () => {
  it('allows a class R action to be speculative, which is the whole point of class R', () => {
    const result = ActionRequest.safeParse(
      request({ actionClass: 'R', speculative: true, confirmed: false }),
    );
    expect(result.success).toBe(true);
  });

  it.each(['C', 'A', 'S'])('refuses a speculative class %s action', (actionClass) => {
    const result = ActionRequest.safeParse(
      request({ actionClass, speculative: true, confirmed: true }),
    );

    expect(result.success).toBe(false);
    expect(issuesOf(result)).toContainEqual(
      expect.objectContaining({
        path: ['speculative'],
        message: 'only a class R action may be executed speculatively',
      }),
    );
  });

  it('refuses a speculative class C action even when it is also confirmed', () => {
    // The dangerous shape: a controller that confirms and speculates in the same breath.
    // Confirmation does not license speculation; the transcript may still be revised.
    const result = ActionRequest.safeParse(
      request({ actionClass: 'C', speculative: true, confirmed: true }),
    );
    expect(result.success).toBe(false);
  });
});

describe('ActionRequest — confirmation', () => {
  it.each(['C', 'S'])('refuses an unconfirmed class %s action', (actionClass) => {
    const result = ActionRequest.safeParse(
      request({ actionClass, speculative: false, confirmed: false }),
    );

    expect(result.success).toBe(false);
    expect(issuesOf(result).map((issue) => issue.path)).toContainEqual(['confirmed']);
  });

  it.each(['C', 'S'])('accepts a confirmed, non-speculative class %s action', (actionClass) => {
    const result = ActionRequest.safeParse(
      request({ actionClass, speculative: false, confirmed: true }),
    );
    expect(result.success).toBe(true);
  });

  it('does not require confirmation for class R', () => {
    const result = ActionRequest.safeParse(
      request({ actionClass: 'R', speculative: false, confirmed: false }),
    );
    expect(result.success).toBe(true);
  });

  it('does not require confirmation for class A at the contract layer', () => {
    // Class A is "pre-stage only": the speculation controller renders a reticle and stops. The
    // request that eventually gets dispatched has been re-resolved, so the contract's job here
    // is only to keep it out of the speculative path — which the rule above already does.
    const result = ActionRequest.safeParse(
      request({ actionClass: 'A', speculative: false, confirmed: false }),
    );
    expect(result.success).toBe(true);
  });
});

function issuesOf(
  result: ReturnType<typeof ActionRequest.safeParse>,
): { path: PropertyKey[]; message: string }[] {
  return result.success
    ? []
    : result.error.issues.map(({ path, message }) => ({ path: [...path], message }));
}
