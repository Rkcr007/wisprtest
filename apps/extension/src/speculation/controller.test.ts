import type { ActionRequest, ResolutionResult, SessionStep } from 'protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutor } from '../executor/index.js';
import { createFakeDispatcher } from '../executor/testing.js';
import type { Disambiguation } from '../resolver/index.js';
import { createSpeculationController, type ResolverLike } from './controller.js';
import { createIntentParser } from './intent.js';
import type { Locator } from './locate.js';

/**
 * The class-C release gate (docs/BUILD-PLAN.md Phase 10). This suite is the one CLAUDE.md calls
 * out: a committing action must never be executed from a partial hypothesis, *including* the case
 * where the partial's text is identical to the final transcript. If this ever goes red, the build
 * does not ship.
 */

const APPROVE_KEY = 'orders.action.approve';
const SEARCH_KEY = 'orders.filter.search';
const RESULTS_KEY = 'orders.table.results';
const ID = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

function resolved(elementKey: string, id: string, confidence = 0.98): ResolutionResult {
  return {
    outcome: 'resolved',
    elementId: id,
    elementKey,
    confidence,
    tier: 'T0',
    latencyMs: 4,
    candidates: [],
  };
}
const NOT_FOUND: ResolutionResult = {
  outcome: 'not_found',
  tier: 'T1',
  latencyMs: 6,
  candidates: [],
};

function fakeResolver(map: Record<string, ResolutionResult>): ResolverLike {
  return { resolve: (phrase) => Promise.resolve(map[phrase] ?? NOT_FOUND) };
}

function fakeLocator(map: Map<string, Element>): Locator {
  return { locate: (_sf, _c, key) => map.get(key) ?? null };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface BuildOptions {
  /** Phase 17's degraded mode: the screen no longer matches the hash memory holds for it. */
  readonly screenDrifted?: () => boolean;
}

function build(
  resolverMap: Record<string, ResolutionResult>,
  elements: Map<string, Element>,
  options: BuildOptions = {},
) {
  return buildWith(fakeResolver(resolverMap), elements, options);
}

function buildWith(
  resolver: ResolverLike,
  elements: Map<string, Element>,
  options: BuildOptions = {},
) {
  const requests: ActionRequest[] = [];
  const steps: SessionStep[] = [];
  const fake = createFakeDispatcher();
  const real = createActionExecutor({
    dispatcher: fake.dispatcher,
    window,
    now: () => 0,
    sleep: () => Promise.resolve(),
    onStep: (s) => steps.push(s),
  });
  const executor: ActionExecutor = {
    dispatch: (req, el, ctx) => {
      requests.push(req);
      return real.dispatch(req, el, ctx);
    },
  };
  const stabilityCallbacks: (() => void)[] = [];
  const controller = createSpeculationController({
    parser: createIntentParser({ vocabulary: { navTargets: new Set(), landmarks: new Set() } }),
    resolver,
    executor,
    locator: fakeLocator(elements),
    source: {
      current: () => ({ stateFingerprint: 'a'.repeat(64), candidates: [...elements.values()] }),
    },
    window,
    now: () => 0,
    stabilityWindowMs: 150,
    schedule: (fn) => {
      stabilityCallbacks.push(fn);
      return () => {
        const i = stabilityCallbacks.indexOf(fn);
        if (i >= 0) stabilityCallbacks.splice(i, 1);
      };
    },
    onStep: (s) => steps.push(s),
    ...(options.screenDrifted === undefined ? {} : { screenDrifted: options.screenDrifted }),
  });
  return {
    requests,
    steps,
    fake,
    controller,
    runStability: () => {
      for (const fn of stabilityCallbacks.splice(0)) fn();
    },
  };
}

describe('SpeculationController — the class-C release gate', () => {
  let button: HTMLButtonElement;
  beforeEach(() => {
    button = document.createElement('button');
    button.textContent = 'Approve';
    document.body.append(button);
  });

  it('NEVER executes a committing action from a partial — including a partial identical to the final', async () => {
    const h = build({ order: resolved(APPROVE_KEY, ID(1)) }, new Map([[APPROVE_KEY, button]]));
    h.controller.onSpeechOnset();

    // Partials for "approve the order". The last one is word-for-word the final transcript — the
    // exact case the gate exists to catch.
    for (const t of ['approve', 'approve the', 'approve the order', 'approve the order']) {
      await h.controller.onPartial({ revision: 1, transcript: t });
      expect(h.requests, `executed from partial "${t}"`).toHaveLength(0);
      expect(h.fake.order, 'dispatched to the app from a partial').toHaveLength(0);
    }

    // A committing action reaches `staged`, never `executed`, on a partial.
    expect(h.controller.view.value.phase).toBe('staged');
    expect(h.controller.view.value.actionClass).toBe('C');
  });

  it('holds a committing action at the final until stability AND an explicit confirmation', async () => {
    const h = build({ order: resolved(APPROVE_KEY, ID(1)) }, new Map([[APPROVE_KEY, button]]));
    h.controller.onSpeechOnset();
    await h.controller.onPartial({ revision: 1, transcript: 'approve the order' });
    await h.controller.onFinal({ revision: 2, transcript: 'approve the order' });

    // Final, but not yet: no stability, no confirmation.
    expect(h.requests).toHaveLength(0);
    expect(h.controller.view.value).toMatchObject({ phase: 'staged', awaitingConfirmation: true });

    // Stability alone is not enough.
    h.runStability();
    await flush();
    expect(h.requests).toHaveLength(0);

    // The explicit yes, after stability, is what finally executes it — exactly once.
    h.controller.confirm();
    await flush();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ actionClass: 'C', speculative: false, confirmed: true });
    expect(h.fake.order).toEqual(['mouse', 'mouse']); // a trusted press + release
    expect(h.controller.view.value.phase).toBe('executed');
  });

  it('executes only after stability even when the tester confirms early', async () => {
    const h = build({ order: resolved(APPROVE_KEY, ID(1)) }, new Map([[APPROVE_KEY, button]]));
    h.controller.onSpeechOnset();
    await h.controller.onFinal({ revision: 1, transcript: 'approve the order' });

    // Confirm arrives before the stability window elapses: it is queued, not obeyed.
    h.controller.confirm();
    await flush();
    expect(h.requests).toHaveLength(0);

    // Stability elapses and the queued confirmation now runs it.
    h.runStability();
    await flush();
    expect(h.requests).toHaveLength(1);
  });
});

describe('SpeculationController — class R speculation and rollback', () => {
  it('executes a reversible action speculatively on a partial and rolls back when it diverges', async () => {
    const search = document.createElement('input');
    const results = document.createElement('input');
    document.body.append(search, results);

    const h = build(
      { 'search box': resolved(SEARCH_KEY, ID(2)), 'results table': resolved(RESULTS_KEY, ID(3)) },
      new Map([
        [SEARCH_KEY, search],
        [RESULTS_KEY, results],
      ]),
    );
    h.controller.onSpeechOnset();

    // First target: focus the search box — reversible, so it runs on the partial.
    await h.controller.onPartial({ revision: 1, transcript: 'focus the search box' });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ actionClass: 'R', speculative: true });
    expect(h.controller.view.value.phase).toBe('aiming');

    // The hypothesis is revised to a different target: the first effect is rolled back, the new one
    // speculated.
    await h.controller.onPartial({ revision: 2, transcript: 'focus the results table' });
    expect(h.steps.some((s) => s.outcome === 'rolled_back')).toBe(true);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.elementKey).toBe(RESULTS_KEY);

    // The final matches the speculated target: it commits without dispatching again.
    await h.controller.onFinal({ revision: 3, transcript: 'focus the results table' });
    expect(h.requests).toHaveLength(2);
    expect(h.controller.view.value.phase).toBe('executed');
  });

  it('does not speculate a reversible action on a screen that has drifted from memory', async () => {
    // Phase 17's degraded mode. The same utterance that speculates above is staged here, because
    // memory for this screen is known to describe a page that changed — and a T0 hit is *more*
    // confident, not less, when it names an element that has since moved.
    const search = document.createElement('input');
    document.body.append(search);

    const h = build(
      { 'search box': resolved(SEARCH_KEY, ID(2)) },
      new Map([[SEARCH_KEY, search]]),
      { screenDrifted: () => true },
    );
    h.controller.onSpeechOnset();

    await h.controller.onPartial({ revision: 1, transcript: 'focus the search box' });

    expect(h.requests, 'speculated against stale memory').toHaveLength(0);
    expect(h.fake.order, 'dispatched to the app from a drifted screen').toHaveLength(0);
    expect(h.controller.view.value.phase).toBe('staged');
    expect(h.controller.view.value.actionClass).toBe('A');
  });

  it('holds a drifted action at the final until an explicit confirmation, then executes it', async () => {
    // "Never block the tester": degraded is not disabled. The action still runs — it just needs
    // the yes that class A requires, rather than going through on a partial.
    const search = document.createElement('input');
    document.body.append(search);

    const h = build(
      { 'search box': resolved(SEARCH_KEY, ID(2)) },
      new Map([[SEARCH_KEY, search]]),
      { screenDrifted: () => true },
    );
    h.controller.onSpeechOnset();

    await h.controller.onFinal({ revision: 1, transcript: 'focus the search box' });
    expect(h.controller.view.value.awaitingConfirmation).toBe(true);
    expect(h.requests).toHaveLength(0);

    h.controller.confirm();
    h.runStability();
    await flush();

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ actionClass: 'A', speculative: false, confirmed: true });
  });

  it('re-reads drift per classification, so a mismatch found mid-session degrades at once', async () => {
    // The predicate is read at classification time rather than captured when the controller is
    // built: drift is discovered on route settle, which happens long after.
    const search = document.createElement('input');
    document.body.append(search);

    let drifted = false;
    const h = build(
      { 'search box': resolved(SEARCH_KEY, ID(2)) },
      new Map([[SEARCH_KEY, search]]),
      {
        screenDrifted: () => drifted,
      },
    );

    h.controller.onSpeechOnset();
    await h.controller.onPartial({ revision: 1, transcript: 'focus the search box' });
    expect(h.requests, 'should speculate while memory still matches').toHaveLength(1);

    drifted = true;
    h.controller.onSpeechOnset();
    await h.controller.onPartial({ revision: 1, transcript: 'focus the search box' });

    expect(h.requests, 'speculated after drift was detected').toHaveLength(1);
    expect(h.controller.view.value.actionClass).toBe('A');
  });

  it('stages an ambiguous (below-threshold) result and never executes it', async () => {
    const button = document.createElement('button');
    document.body.append(button);
    const h = build({}, new Map([[APPROVE_KEY, button]])); // resolver returns not_found
    h.controller.onSpeechOnset();

    await h.controller.onFinal({ revision: 1, transcript: 'click the mystery control' });
    expect(h.requests).toHaveLength(0);
    expect(h.controller.view.value.phase).toBe('staged');
    expect(h.steps.at(-1)?.outcome).toBe('staged');
  });
});

describe('answering a disambiguation keeps the intent that asked', () => {
  /** A resolver that offers a choice for one phrase and resolves whatever ordinal is picked. */
  function choosingResolver(pick: ResolutionResult): ResolverLike & {
    chosen: number[];
    cleared: number;
  } {
    const state = { chosen: [] as number[], cleared: 0 };
    let open: Disambiguation | null = null;

    return {
      chosen: state.chosen,
      get cleared() {
        return state.cleared;
      },
      resolve: (phrase) => {
        // Every phrase is ambiguous here: what is under test is what happens *after* a question is
        // asked, not which phrases raise one.
        open = {
          phrase,
          stateFingerprint: 'a'.repeat(64),
          tier: 'T2',
          choices: [
            { ordinal: 1, candidate: candidateOf(RESULTS_KEY, ID(9)) },
            { ordinal: 2, candidate: candidateOf(SEARCH_KEY, ID(2)) },
          ],
        };
        return Promise.resolve({
          outcome: 'ambiguous',
          tier: 'T2',
          latencyMs: 9,
          candidates: [candidateOf(RESULTS_KEY, ID(9)), candidateOf(SEARCH_KEY, ID(2))],
        });
      },
      pending: () => open,
      choose: (ordinal) => {
        state.chosen.push(ordinal);
        open = null;
        return pick;
      },
      clearPending: () => {
        state.cleared += 1;
        open = null;
      },
    };
  }

  function candidateOf(elementKey: string, elementId: string) {
    return { elementId, elementKey, label: elementKey, confidence: 0.5, signalScores: {} };
  }

  let field: HTMLInputElement;
  beforeEach(() => {
    field = document.createElement('input');
    document.body.append(field);
  });

  it('runs the original verb, not the one the word "two" would parse as', async () => {
    // "focus" is class R and executes on sight; a bare "two" would parse as `click`, which is
    // class C and would sit staged awaiting a confirmation. The verb is the assertion.
    const resolver = choosingResolver(resolved(SEARCH_KEY, ID(2)));
    const h = buildWith(resolver, new Map([[SEARCH_KEY, field]]));

    h.controller.onSpeechOnset();
    await h.controller.onFinal({ revision: 1, transcript: 'focus the box for the customer' });
    expect(h.requests, 'an ambiguous phrase must not execute').toHaveLength(0);

    // A new breath, then the answer.
    h.controller.onSpeechOnset();
    await h.controller.onFinal({ revision: 2, transcript: 'two' });

    expect(resolver.chosen).toEqual([2]);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.payload.verb).toBe('focus');
    expect(h.requests[0]?.elementKey).toBe(SEARCH_KEY);
    expect(h.controller.view.value.phase).toBe('executed');
  });

  it('carries the value the tester was dictating through the pick', async () => {
    const resolver = choosingResolver(resolved(SEARCH_KEY, ID(2)));
    const h = buildWith(resolver, new Map([[SEARCH_KEY, field]]));

    h.controller.onSpeechOnset();
    await h.controller.onFinal({
      revision: 1,
      transcript: 'type acme in the box for the customer',
    });

    h.controller.onSpeechOnset();
    await h.controller.onFinal({ revision: 2, transcript: 'two' });

    // Re-parsing "two" would have lost the text entirely, and typed nothing into the field the
    // tester just pointed at.
    const payload = h.requests[0]?.payload;
    expect(payload?.verb).toBe('type');
    expect(payload).toMatchObject({ text: 'acme' });
  });

  it('does not answer from a partial hypothesis', async () => {
    const resolver = choosingResolver(resolved(SEARCH_KEY, ID(2)));
    const h = buildWith(resolver, new Map([[SEARCH_KEY, field]]));

    h.controller.onSpeechOnset();
    await h.controller.onFinal({ revision: 1, transcript: 'focus the box for the customer' });

    h.controller.onSpeechOnset();
    await h.controller.onPartial({ revision: 2, transcript: 'two' });

    // A pick closes the list and teaches the system an alias. A partial that a revision could still
    // take back must do neither.
    expect(resolver.chosen).toEqual([]);
    expect(h.requests).toHaveLength(0);
  });

  it('treats an utterance that merely contains an ordinal as a fresh command', async () => {
    const resolver = choosingResolver(resolved(SEARCH_KEY, ID(2)));
    const h = buildWith(resolver, new Map([[SEARCH_KEY, field]]));

    h.controller.onSpeechOnset();
    await h.controller.onFinal({ revision: 1, transcript: 'focus the box for the customer' });

    h.controller.onSpeechOnset();
    await h.controller.onFinal({ revision: 2, transcript: 'approve order two' });

    // Hijacking this would fire an action on whichever element happened to be second.
    expect(resolver.chosen).toEqual([]);
  });

  it('drops the open choice when the tester cancels', async () => {
    const resolver = choosingResolver(resolved(SEARCH_KEY, ID(2)));
    const h = buildWith(resolver, new Map([[SEARCH_KEY, field]]));

    h.controller.onSpeechOnset();
    await h.controller.onFinal({ revision: 1, transcript: 'focus the box for the customer' });
    h.controller.cancel();

    expect(resolver.cleared).toBe(1);

    // The question is gone, so "two" is just a phrase to resolve — not an answer to it.
    h.controller.onSpeechOnset();
    await h.controller.onFinal({ revision: 2, transcript: 'two' });
    expect(resolver.chosen).toEqual([]);
  });
});
