import type { SessionStep } from 'protocol';
import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type DispatchContext } from './executor.js';
import {
  createFakeDispatcher,
  ELEMENT_ID,
  makeActionRequest,
  makeResolved,
  makeScopedQuery,
} from './testing.js';

/** A monotonic clock: each call advances 5ms, so latency assertions are exact. */
function countingNow(): () => number {
  let t = 0;
  return () => (t += 5);
}

function context(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    sessionId: makeActionRequest().sessionId,
    ordinal: 0,
    utterance: 'approve it',
    intent: makeScopedQuery(),
    resolution: makeResolved(),
    onsetAt: 0,
    ...overrides,
  };
}

function setup(options: { fail?: boolean; sleep?: (ms: number) => Promise<void> } = {}) {
  const fake = createFakeDispatcher(options.fail === undefined ? {} : { fail: options.fail });
  const steps: SessionStep[] = [];
  const executor = createActionExecutor({
    dispatcher: fake.dispatcher,
    window,
    now: countingNow(),
    sleep: options.sleep ?? (() => Promise.resolve()),
    interKeyDelayMs: 24,
    onStep: (step) => steps.push(step),
  });
  return { fake, steps, executor };
}

describe('ActionExecutor — click', () => {
  it('dispatches a trusted press then release, and emits an executed step', async () => {
    const { fake, steps, executor } = setup();
    const button = document.createElement('button');
    document.body.append(button);

    const result = await executor.dispatch(
      makeActionRequest({ payload: { verb: 'click' }, actionClass: 'C', confirmed: true }),
      button,
      context(),
    );

    expect(fake.mouse.map((m) => m.type)).toEqual(['mousePressed', 'mouseReleased']);
    expect(fake.mouse.every((m) => m.button === 'left' && m.clickCount === 1)).toBe(true);
    expect(result.outcome).toBe('executed');

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      outcome: 'executed',
      actionClass: 'C',
      tier: 'T0',
      elementId: ELEMENT_ID,
    });
    button.remove();
  });
});

describe('ActionExecutor — type', () => {
  it('types the raw text as trusted keystrokes, not the redacted payload text', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const { fake, executor } = setup({ sleep });
    const input = document.createElement('input');
    document.body.append(input);

    await executor.dispatch(
      // The payload text is redacted; the raw characters travel out of band.
      makeActionRequest({ payload: { verb: 'type', text: '[redacted]', clearFirst: true } }),
      input,
      context({ rawText: 'ab' }),
    );

    // Two characters, each a down/up pair, in order — and the actual letters, not the mask.
    expect(fake.key.map((k) => k.type)).toEqual(['keyDown', 'keyUp', 'keyDown', 'keyUp']);
    expect(fake.key.filter((k) => k.type === 'keyDown').map((k) => k.text)).toEqual(['a', 'b']);
    // One inter-key pause: between the two characters, never a trailing one.
    expect(sleep).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it('presses Enter after typing a filter value', async () => {
    const { fake, executor } = setup();
    const input = document.createElement('input');
    document.body.append(input);

    await executor.dispatch(
      makeActionRequest({ payload: { verb: 'filter', text: 'pending' } }),
      input,
      context({ rawText: 'pending' }),
    );

    const last = fake.key.slice(-2);
    expect(last.map((k) => k.type)).toEqual(['keyDown', 'keyUp']);
    expect(last.every((k) => k.key === 'Enter')).toBe(true);
    input.remove();
  });
});

describe('ActionExecutor — DOM verbs', () => {
  it('scrolls the window for a scroll action, no CDP involved', async () => {
    const { fake, executor } = setup();
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);

    await executor.dispatch(
      makeActionRequest({ payload: { verb: 'scroll', direction: 'down', amountPx: 300 } }),
      document.createElement('div'),
      context(),
    );

    expect(scrollBy).toHaveBeenCalledWith(0, 300);
    expect(fake.order).toHaveLength(0);
    scrollBy.mockRestore();
  });

  it('moves the selection and fires change for select', async () => {
    const { executor } = setup();
    const select = document.createElement('select');
    for (const v of ['pending', 'approved']) {
      const option = document.createElement('option');
      option.value = v;
      option.textContent = v;
      select.append(option);
    }
    document.body.append(select);
    const changed = vi.fn();
    select.addEventListener('change', changed);

    await executor.dispatch(
      makeActionRequest({ payload: { verb: 'select', option: 'approved' } }),
      select,
      context({ rawText: 'approved' }),
    );

    expect(select.value).toBe('approved');
    expect(changed).toHaveBeenCalledTimes(1);
    select.remove();
  });

  it('goes back in history for back', async () => {
    const { executor } = setup();
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);

    await executor.dispatch(
      makeActionRequest({ payload: { verb: 'back' } }),
      document.createElement('a'),
      context(),
    );

    expect(back).toHaveBeenCalledTimes(1);
    back.mockRestore();
  });
});

describe('ActionExecutor — end to end latency and failure', () => {
  it('records an end-to-end latency from speech onset, longer than the dispatch latency', async () => {
    const { steps, executor } = setup();
    const result = await executor.dispatch(
      makeActionRequest({ payload: { verb: 'focus' } }),
      document.createElement('button'),
      context({ onsetAt: 0 }),
    );
    // The step spans onset→completion; the result spans commit→completion. Both are positive and
    // the step's is at least the result's, since onset precedes commit.
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(steps[0]?.latencyMs).toBeGreaterThanOrEqual(result.latencyMs);
  });

  it('reports a failed dispatch with a reason rather than throwing', async () => {
    const { steps, executor } = setup({ fail: true });
    const result = await executor.dispatch(
      makeActionRequest({ payload: { verb: 'click' }, actionClass: 'C', confirmed: true }),
      document.createElement('button'),
      context(),
    );
    expect(result.outcome).toBe('failed');
    expect(result.reason).toContain('debugger detached');
    expect(steps[0]?.outcome).toBe('failed');
  });
});
