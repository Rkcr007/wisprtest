import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMutationStream,
  DEFAULT_DEBOUNCE_MS,
  WATCHED_ATTRIBUTES,
  type MutationBurst,
} from './mutations.js';
import {
  createManualMutationObserver,
  createManualScheduler,
  mutationRecord,
  type ManualMutationObserver,
  type ManualScheduler,
} from './testing.js';

describe('createMutationStream', () => {
  let scheduler: ManualScheduler;
  let observer: ManualMutationObserver;
  let bursts: MutationBurst[];

  function build(onSettle?: () => void) {
    return createMutationStream({
      onBurst: (burst) => bursts.push(burst),
      ...(onSettle === undefined ? {} : { onSettle }),
      scheduler,
      observerFactory: (callback) => {
        observer = createManualMutationObserver(callback);
        return observer.observer;
      },
    });
  }

  function record(): MutationRecord {
    return mutationRecord({ type: 'childList', target: document.body });
  }

  beforeEach(() => {
    scheduler = createManualScheduler();
    bursts = [];
  });

  it('dispatches the first record immediately, without waiting for the window', () => {
    build();
    observer.deliver([record()]);

    // The leading edge is what keeps the scoped index from being 50 ms — a fifth of the whole
    // speech-to-reticle budget — behind the tester's click.
    expect(bursts).toHaveLength(1);
    expect(bursts[0]?.leading).toBe(true);
    expect(bursts[0]?.records).toHaveLength(1);
  });

  it('coalesces everything in the window into one trailing burst', () => {
    build();
    observer.deliver([record()]);
    observer.deliver([record(), record()]);
    observer.deliver([record()]);

    expect(bursts).toHaveLength(1);

    scheduler.runPending();

    expect(bursts).toHaveLength(2);
    expect(bursts[1]?.leading).toBe(false);
    expect(bursts[1]?.records).toHaveLength(3);
  });

  it('settles when the window closes with nothing accumulated', () => {
    const onSettle = vi.fn();
    build(onSettle);

    observer.deliver([record()]);
    expect(onSettle).not.toHaveBeenCalled();

    scheduler.runPending();

    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(bursts).toHaveLength(1);
    // Not rearmed. A quiet page schedules nothing at all — the requirement is "never polling,
    // never setInterval", and an idle timer would be both.
    expect(scheduler.pendingCount).toBe(0);
  });

  it('rearms while records keep arriving, so a busy page dispatches on a fixed cadence', () => {
    const onSettle = vi.fn();
    build(onSettle);

    observer.deliver([record()]);
    observer.deliver([record()]);
    scheduler.runPending();
    expect(bursts).toHaveLength(2);
    expect(scheduler.pendingCount).toBe(1);

    observer.deliver([record()]);
    scheduler.runPending();
    expect(bursts).toHaveLength(3);
    expect(bursts[2]?.leading).toBe(false);

    scheduler.runPending();
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it('takes a leading edge again after a settle', () => {
    build(() => undefined);
    observer.deliver([record()]);
    scheduler.runPending();

    observer.deliver([record()]);

    expect(bursts).toHaveLength(2);
    expect(bursts[1]?.leading).toBe(true);
  });

  it('flush drains what the observer has queued but not delivered', () => {
    const stream = build();
    observer.queue([record(), record()]);

    expect(bursts).toHaveLength(0);
    stream.flush();

    // `MutationObserver` delivers on a microtask. The action executor mutates the DOM and then
    // resolves against the index in the same turn, so it needs the records now.
    expect(bursts).toHaveLength(1);
    expect(bursts[0]?.records).toHaveLength(2);
  });

  it('observes with the attribute filter and stops on dispose', () => {
    const stream = build();
    const spy = vi.spyOn(observer.observer, 'observe');
    stream.observe(document.documentElement);

    expect(spy).toHaveBeenCalledWith(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [...WATCHED_ATTRIBUTES],
    });

    stream.dispose();
    observer.deliver([record()]);
    expect(bursts).toHaveLength(0);
  });

  it('watches no attribute that only changes CSS visibility', () => {
    // `class` and `style` are how CSS visibility changes, and IntersectionObserver reports that
    // directly. Watching them would double the record volume on every hover in the application
    // to learn something the visibility tracker already knows.
    expect(WATCHED_ATTRIBUTES).not.toContain('class');
    expect(WATCHED_ATTRIBUTES).not.toContain('style');
  });

  it('uses the 50ms window from the build plan by default', () => {
    expect(DEFAULT_DEBOUNCE_MS).toBe(50);

    const setTimeoutSpy = vi.spyOn(scheduler, 'setTimeout');
    build();
    observer.deliver([record()]);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 50);
  });
});
