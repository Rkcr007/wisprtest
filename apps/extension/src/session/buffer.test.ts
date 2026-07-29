import type { SessionStep } from 'protocol';
import { describe, expect, it } from 'vitest';

import { createSessionBuffer, type BufferStore } from './buffer.js';
import { createBufferStore, bufferKey, type SessionStorageArea } from './store.js';

/**
 * The session step buffer.
 *
 * Two properties the phase names outright, and one that makes them work:
 *
 * - **Flush every 5s and on detach.** The control plane is not on the hot path; a request per
 *   action would put it back there.
 * - **Survive a service-worker restart mid-session without losing buffered steps.** Chrome
 *   terminates an idle MV3 worker after ~30s. A buffer that lived only in memory would lose the
 *   last actions of every session where the tester paused — which is when the interesting steps
 *   happen.
 * - **At-least-once delivery.** Steps are dropped only after the gateway confirms them, which is
 *   safe precisely because ingest is idempotent on `(sessionId, ordinal)`. The two halves only
 *   work together.
 */

const SESSION = '9c5b94b1-35ad-49bb-b118-8e8fc24abf80';

function step(ordinal: number): SessionStep {
  return {
    id: crypto.randomUUID(),
    sessionId: SESSION,
    ordinal,
    utterance: 'approve it',
    intent: {
      verb: 'click',
      targetPhrase: 'approve',
      constraints: [],
      stateFingerprint: 'a'.repeat(64),
      candidateElementKeys: ['orders.detail.approve'],
    },
    resolution: {
      outcome: 'resolved',
      elementId: '55555555-5555-4555-8555-555555555551',
      elementKey: 'orders.detail.approve',
      confidence: 0.98,
      tier: 'T0',
      latencyMs: 6,
      candidates: [],
    },
    elementId: null,
    tier: 'T0',
    confidence: 0.98,
    actionClass: 'C',
    latencyMs: 240,
    outcome: 'executed',
    evidence: [],
    createdAt: '2026-07-29T09:30:00.000Z',
  };
}

/** An in-memory `chrome.storage.session`, so a restart is just a second store over one map. */
function fakeArea(): SessionStorageArea & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: (key: string) => Promise.resolve(data.has(key) ? { [key]: data.get(key) } : {}),
    set: (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
      return Promise.resolve();
    },
    remove: (key: string) => {
      data.delete(key);
      return Promise.resolve();
    },
    setAccessLevel: () => Promise.resolve(),
  };
}

/** A schedule that hands the tick to the test rather than waiting on a real timer. */
function manualInterval(): {
  fire: () => void;
  cancelled: () => boolean;
  intervalMs: () => number;
  schedule: (fn: () => void, ms: number) => () => void;
} {
  let tick: (() => void) | null = null;
  let cancelled = false;
  let ms = -1;
  return {
    fire: () => tick?.(),
    cancelled: () => cancelled,
    intervalMs: () => ms,
    schedule: (fn, interval) => {
      tick = fn;
      ms = interval;
      return () => {
        cancelled = true;
      };
    },
  };
}

describe('batching', () => {
  it('holds steps and sends them on the tick, not per action', async () => {
    const timer = manualInterval();
    const sent: SessionStep[][] = [];
    const buffer = await createSessionBuffer({
      sessionId: SESSION,
      store: createBufferStore(fakeArea()),
      scheduleInterval: timer.schedule,
      send: (_id, steps) => {
        sent.push([...steps]);
        return Promise.resolve();
      },
    });

    buffer.add(step(0));
    buffer.add(step(1));

    expect(sent).toHaveLength(0);
    expect(buffer.size).toBe(2);

    timer.fire();
    await buffer.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
    expect(buffer.size).toBe(0);
  });

  it('flushes every 5 seconds by default', async () => {
    const timer = manualInterval();
    await createSessionBuffer({
      sessionId: SESSION,
      store: createBufferStore(fakeArea()),
      scheduleInterval: timer.schedule,
      send: () => Promise.resolve(),
    });

    expect(timer.intervalMs()).toBe(5_000);
  });

  it('splits a long buffer across requests', async () => {
    const sent: SessionStep[][] = [];
    const buffer = await createSessionBuffer({
      sessionId: SESSION,
      store: createBufferStore(fakeArea()),
      scheduleInterval: manualInterval().schedule,
      maxBatch: 2,
      send: (_id, steps) => {
        sent.push([...steps]);
        return Promise.resolve();
      },
    });

    for (let ordinal = 0; ordinal < 5; ordinal += 1) buffer.add(step(ordinal));
    await buffer.flush();

    expect(sent.map((batch) => batch.length)).toEqual([2, 2, 1]);
    // Oldest first, so a timeline arrives in the order it happened.
    expect(sent[0]?.[0]?.ordinal).toBe(0);
  });
});

describe('on detach', () => {
  it('flushes what it holds and stops the timer', async () => {
    const timer = manualInterval();
    const sent: SessionStep[][] = [];
    const buffer = await createSessionBuffer({
      sessionId: SESSION,
      store: createBufferStore(fakeArea()),
      scheduleInterval: timer.schedule,
      send: (_id, steps) => {
        sent.push([...steps]);
        return Promise.resolve();
      },
    });

    buffer.add(step(0));
    await buffer.close();

    // The last actions of a sitting are the ones most likely to be lost, and most likely to matter.
    expect(sent).toHaveLength(1);
    expect(timer.cancelled()).toBe(true);
  });

  it('clears storage only once the buffer actually drained', async () => {
    const area = fakeArea();
    const buffer = await createSessionBuffer({
      sessionId: SESSION,
      store: createBufferStore(area),
      scheduleInterval: manualInterval().schedule,
      send: () => Promise.reject(new Error('gateway down')),
      onError: () => undefined,
    });

    buffer.add(step(0));
    await buffer.close();

    // Clearing regardless would throw away the very thing that was supposed to survive.
    expect(area.data.has(bufferKey(SESSION))).toBe(true);
    expect(buffer.size).toBe(1);
  });
});

describe('surviving a service worker restart', () => {
  it('rehydrates steps the previous worker never got to send', async () => {
    const area = fakeArea();
    const store = createBufferStore(area);

    // Worker one: records three steps, flushes none — Chrome terminates it mid-session.
    const first = await createSessionBuffer({
      sessionId: SESSION,
      store,
      scheduleInterval: manualInterval().schedule,
      send: () => Promise.resolve(),
    });
    first.add(step(0));
    first.add(step(1));
    first.add(step(2));
    // No flush, no close: the worker is simply gone. Everything it held is in storage.

    const sent: SessionStep[][] = [];
    // Worker two: a fresh process, same session.
    const second = await createSessionBuffer({
      sessionId: SESSION,
      store,
      scheduleInterval: manualInterval().schedule,
      send: (_id, steps) => {
        sent.push([...steps]);
        return Promise.resolve();
      },
    });

    expect(second.size, 'the restart lost nothing').toBe(3);
    await second.flush();
    expect(sent[0]?.map((s) => s.ordinal)).toEqual([0, 1, 2]);
  });

  it('keeps a partially-flushed buffer consistent across the restart', async () => {
    const area = fakeArea();
    const store = createBufferStore(area);

    const first = await createSessionBuffer({
      sessionId: SESSION,
      store,
      scheduleInterval: manualInterval().schedule,
      maxBatch: 2,
      // The second batch never lands: the worker dies mid-flush.
      send: (_id, steps) =>
        steps[0]?.ordinal === 0 ? Promise.resolve() : Promise.reject(new Error('gone')),
      onError: () => undefined,
    });
    for (let ordinal = 0; ordinal < 4; ordinal += 1) first.add(step(ordinal));
    await first.flush();

    const second = await createSessionBuffer({
      sessionId: SESSION,
      store,
      scheduleInterval: manualInterval().schedule,
      send: () => Promise.resolve(),
    });

    // The confirmed batch is gone and the unconfirmed one survived. Nothing is recorded twice by
    // accident here — and if the confirmation was merely lost in flight, ingest's idempotency is
    // what makes the resend harmless.
    expect(second.size).toBe(2);
  });

  it('does not restore another session’s steps', async () => {
    const area = fakeArea();
    const store = createBufferStore(area);

    const mine = await createSessionBuffer({
      sessionId: SESSION,
      store,
      scheduleInterval: manualInterval().schedule,
      send: () => Promise.resolve(),
    });
    mine.add(step(0));

    const other = await createSessionBuffer({
      sessionId: '11111111-1111-4111-8111-111111111111',
      store,
      scheduleInterval: manualInterval().schedule,
      send: () => Promise.resolve(),
    });

    // Keyed per session: one tester's history must not surface in another session's timeline.
    expect(other.size).toBe(0);
  });

  it('drops a stored step that no longer matches the contract, keeping the rest', async () => {
    const area = fakeArea();
    await area.set({ [bufferKey(SESSION)]: [step(0), { ordinal: 'not a step' }, step(2)] });

    const errors: unknown[] = [];
    const buffer = await createSessionBuffer({
      sessionId: SESSION,
      store: createBufferStore(area, (error) => errors.push(error)),
      scheduleInterval: manualInterval().schedule,
      send: () => Promise.resolve(),
    });

    // An extension upgrade can change the shape under a buffer written by the previous version.
    // One bad row is not a reason to discard a tester's whole session.
    expect(buffer.size).toBe(2);
    expect(errors).toHaveLength(1);
  });
});

describe('when the gateway is unhappy', () => {
  it('keeps steps that a retry could still deliver', async () => {
    let attempts = 0;
    const buffer = await createSessionBuffer({
      sessionId: SESSION,
      store: createBufferStore(fakeArea()),
      scheduleInterval: manualInterval().schedule,
      send: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error('503')) : Promise.resolve();
      },
      onError: () => undefined,
    });

    buffer.add(step(0));
    await buffer.flush();
    expect(buffer.size, 'a tester’s history is not discarded over a blip').toBe(1);

    await buffer.flush();
    expect(buffer.size).toBe(0);
    expect(attempts).toBe(2);
  });

  it('discards a batch the gateway will never accept', async () => {
    let attempts = 0;
    const buffer = await createSessionBuffer({
      sessionId: SESSION,
      store: createBufferStore(fakeArea()),
      scheduleInterval: manualInterval().schedule,
      send: () => {
        attempts += 1;
        return Promise.reject(Object.assign(new Error('session closed'), { retryable: false }));
      },
      onError: () => undefined,
    });

    buffer.add(step(0));
    await buffer.flush();

    // A closed session is the common case: the tab went away mid-flush. Retrying forever would
    // wedge everything behind it.
    expect(buffer.size).toBe(0);
    expect(attempts).toBe(1);
  });

  it('caps what it holds, dropping the oldest first', async () => {
    const buffer = await createSessionBuffer({
      sessionId: SESSION,
      store: createBufferStore(fakeArea()),
      scheduleInterval: manualInterval().schedule,
      maxPending: 3,
      maxBatch: 10,
      send: () => Promise.reject(new Error('down')),
      onError: () => undefined,
    });

    for (let ordinal = 0; ordinal < 6; ordinal += 1) buffer.add(step(ordinal));

    expect(buffer.size).toBe(3);
    await buffer.flush();
    expect(buffer.size).toBe(3);
  });

  it('ignores steps added after close', async () => {
    const buffer = await createSessionBuffer({
      sessionId: SESSION,
      store: createBufferStore(fakeArea()),
      scheduleInterval: manualInterval().schedule,
      send: () => Promise.resolve(),
    });

    await buffer.close();
    buffer.add(step(0));

    expect(buffer.size).toBe(0);
  });
});

describe('storage', () => {
  it('closes the buffer to content scripts', async () => {
    const area = fakeArea();
    let level: string | null = null;
    const guarded: SessionStorageArea = {
      ...area,
      setAccessLevel: (options) => {
        level = options.accessLevel;
        return Promise.resolve();
      },
    };

    createBufferStore(guarded);
    await Promise.resolve();

    // A buffered step carries the redacted utterance and the element keys of the application under
    // test. The page the content script shares must not be able to read them.
    expect(level).toBe('TRUSTED_CONTEXTS');
  });

  it('namespaces its keys per session', () => {
    expect(bufferKey(SESSION)).toBe(`wispr:steps:${SESSION}`);
  });

  it('reads an absent buffer as empty rather than failing', async () => {
    const store: BufferStore = createBufferStore(fakeArea());
    await expect(store.read('never-written')).resolves.toEqual([]);
  });
});
