import {
  ActionRequest,
  type ActionClass,
  type ActionPayload,
  type ResolutionResult,
  type ScopedQuery,
  type Tier,
} from 'protocol';

import type { CdpDispatcher, CdpKeyEvent, CdpMouseEvent } from './cdp.js';

/**
 * Builders and a recording dispatcher for the executor and speculation suites.
 *
 * Not a `.test.ts`, so vitest does not run it, and never imported by an entrypoint, so the bundler
 * never ships it. It exists so both suites construct *contract-valid* `ActionRequest`s — the
 * reversibility refinements are real, and a builder that produced an invalid one would fail at the
 * schema rather than at the assertion that matters.
 */

export const HASH64 = 'a'.repeat(64);
export const SESSION_ID = '00000000-0000-4000-8000-000000000001';
export const ELEMENT_ID = '00000000-0000-4000-8000-000000000002';
export const REQUEST_ID = '00000000-0000-4000-8000-000000000003';
export const ELEMENT_KEY = 'orders.filter.pending';

export interface FakeDispatcher {
  readonly dispatcher: CdpDispatcher;
  readonly mouse: CdpMouseEvent[];
  readonly key: CdpKeyEvent[];
  /** Every command in the order it was dispatched, for asserting interleaving. */
  readonly order: ('mouse' | 'key')[];
}

export function createFakeDispatcher(options: { fail?: boolean } = {}): FakeDispatcher {
  const mouse: CdpMouseEvent[] = [];
  const key: CdpKeyEvent[] = [];
  const order: ('mouse' | 'key')[] = [];
  return {
    mouse,
    key,
    order,
    dispatcher: {
      mouse(event): Promise<void> {
        if (options.fail === true) return Promise.reject(new Error('debugger detached'));
        mouse.push(event);
        order.push('mouse');
        return Promise.resolve();
      },
      key(event): Promise<void> {
        if (options.fail === true) return Promise.reject(new Error('debugger detached'));
        key.push(event);
        order.push('key');
        return Promise.resolve();
      },
    },
  };
}

export interface RequestOverrides {
  readonly payload?: ActionPayload;
  readonly actionClass?: ActionClass;
  readonly tier?: Tier;
  readonly confidence?: number;
  readonly speculative?: boolean;
  readonly confirmed?: boolean;
}

export function makeActionRequest(overrides: RequestOverrides = {}): ActionRequest {
  const actionClass = overrides.actionClass ?? 'R';
  // Default to a shape the refinements accept: a class-C default would need confirmation, so unless
  // asked otherwise the confirmed flag follows the class.
  const confirmed = overrides.confirmed ?? (actionClass === 'C' || actionClass === 'S');
  return ActionRequest.parse({
    id: REQUEST_ID,
    sessionId: SESSION_ID,
    elementId: ELEMENT_ID,
    elementKey: ELEMENT_KEY,
    payload: overrides.payload ?? { verb: 'focus' },
    actionClass,
    tier: overrides.tier ?? 'T0',
    confidence: overrides.confidence ?? 0.98,
    speculative: overrides.speculative ?? false,
    confirmed,
    stateFingerprint: HASH64,
    issuedAt: '2026-07-29T00:00:00.000Z',
  });
}

export function makeScopedQuery(overrides: Partial<ScopedQuery> = {}): ScopedQuery {
  return {
    verb: overrides.verb ?? 'click',
    targetPhrase: overrides.targetPhrase ?? 'approve',
    constraints: overrides.constraints ?? [],
    stateFingerprint: overrides.stateFingerprint ?? HASH64,
    candidateElementKeys: overrides.candidateElementKeys ?? [ELEMENT_KEY],
  };
}

export function makeResolved(
  overrides: Partial<Extract<ResolutionResult, { outcome: 'resolved' }>> = {},
): ResolutionResult {
  return {
    outcome: 'resolved',
    elementId: overrides.elementId ?? ELEMENT_ID,
    elementKey: overrides.elementKey ?? ELEMENT_KEY,
    confidence: overrides.confidence ?? 0.98,
    tier: overrides.tier ?? 'T0',
    latencyMs: overrides.latencyMs ?? 4,
    candidates: overrides.candidates ?? [],
  };
}
