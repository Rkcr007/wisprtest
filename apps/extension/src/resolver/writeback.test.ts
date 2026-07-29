import type { AliasWriteback } from 'protocol';
import { describe, expect, it } from 'vitest';

import { createWritebackQueue } from './writeback.js';

/**
 * The write-back queue.
 *
 * What the phase specifies — "flush the queue in batches every 10s and on detach" — plus the
 * behaviour that decides whether the compounding loop survives an ordinary bad afternoon: a
 * gateway that is briefly down must not cost the tenant its learning, and a batch the gateway will
 * reject forever must not be retried forever.
 */

const STATE = 'a'.repeat(64);

function writeback(
  phrase: string,
  elementId = '11111111-1111-4111-8111-111111111111',
): AliasWriteback {
  return { phrase, elementId, stateFingerprint: STATE, source: 't2_writeback' };
}

/** A schedule that hands the tick back to the test rather than waiting on a real timer. */
function manualInterval(): {
  fire: () => void;
  cancelled: () => boolean;
  schedule: (fn: () => void, ms: number) => () => void;
  intervalMs: () => number;
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
  it('holds write-backs and sends them on the tick, not per resolution', async () => {
    const timer = manualInterval();
    const sent: AliasWriteback[][] = [];
    const queue = createWritebackQueue({
      send: (items) => {
        sent.push([...items]);
        return Promise.resolve();
      },
      scheduleInterval: timer.schedule,
    });

    queue.enqueue(writeback('sign off on this'));
    queue.enqueue(writeback('put it on hold'));

    // Nothing has gone out yet: a request per resolution would put the control plane back on the
    // hot path it was taken off.
    expect(sent).toHaveLength(0);
    expect(queue.size).toBe(2);

    timer.fire();
    await queue.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
    expect(queue.size).toBe(0);
  });

  it('flushes every 10 seconds by default', () => {
    const timer = manualInterval();
    createWritebackQueue({ send: () => Promise.resolve(), scheduleInterval: timer.schedule });

    expect(timer.intervalMs()).toBe(10_000);
  });

  it('folds a repeated phrase into one write-back', async () => {
    const sent: AliasWriteback[][] = [];
    const queue = createWritebackQueue({
      send: (items) => {
        sent.push([...items]);
        return Promise.resolve();
      },
      scheduleInterval: manualInterval().schedule,
    });

    queue.enqueue(writeback('show me the pending ones'));
    queue.enqueue(writeback('show me the pending ones'));
    queue.enqueue(writeback('show me the pending ones'));

    expect(queue.size).toBe(1);
    await queue.flush();
    expect(sent[0]).toHaveLength(1);
  });

  it('splits a long queue across requests', async () => {
    const sent: AliasWriteback[][] = [];
    const queue = createWritebackQueue({
      send: (items) => {
        sent.push([...items]);
        return Promise.resolve();
      },
      maxBatch: 2,
      scheduleInterval: manualInterval().schedule,
    });

    for (const phrase of ['a one', 'a two', 'a three', 'a four', 'a five']) {
      queue.enqueue(writeback(phrase));
    }
    await queue.flush();

    expect(sent.map((batch) => batch.length)).toEqual([2, 2, 1]);
  });
});

describe('on detach', () => {
  it('flushes what it holds and stops the timer', async () => {
    const timer = manualInterval();
    const sent: AliasWriteback[][] = [];
    const queue = createWritebackQueue({
      send: (items) => {
        sent.push([...items]);
        return Promise.resolve();
      },
      scheduleInterval: timer.schedule,
    });

    queue.enqueue(writeback('learned right before detach'));
    await queue.close();

    // The last thing a session learned is the thing most likely to be lost. It is not.
    expect(sent).toHaveLength(1);
    expect(timer.cancelled()).toBe(true);
  });

  it('ignores anything enqueued after close', async () => {
    const queue = createWritebackQueue({
      send: () => Promise.resolve(),
      scheduleInterval: manualInterval().schedule,
    });

    await queue.close();
    queue.enqueue(writeback('too late'));

    expect(queue.size).toBe(0);
  });
});

describe('when the gateway is unhappy', () => {
  it('keeps the batch when the failure could pass', async () => {
    let attempts = 0;
    const queue = createWritebackQueue({
      send: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error('503')) : Promise.resolve();
      },
      scheduleInterval: manualInterval().schedule,
      onError: () => undefined,
    });

    queue.enqueue(writeback('worth keeping'));
    await queue.flush();

    // Still held: learning is the compounding asset, and a blip is not a reason to discard it.
    expect(queue.size).toBe(1);

    await queue.flush();
    expect(queue.size).toBe(0);
    expect(attempts).toBe(2);
  });

  it('drops a batch the sender says will never be accepted', async () => {
    let attempts = 0;
    const queue = createWritebackQueue({
      send: () => {
        attempts += 1;
        return Promise.reject(Object.assign(new Error('422'), { retryable: false }));
      },
      scheduleInterval: manualInterval().schedule,
      onError: () => undefined,
    });

    queue.enqueue(writeback('rejected forever'));
    await queue.flush();

    // Re-queueing a permanently rejected batch is an infinite loop with a network hop in it.
    expect(queue.size).toBe(0);
    expect(attempts).toBe(1);
  });

  it('caps what it holds, dropping the oldest first', async () => {
    const queue = createWritebackQueue({
      send: () => Promise.reject(new Error('down')),
      maxPending: 3,
      maxBatch: 10,
      scheduleInterval: manualInterval().schedule,
      onError: () => undefined,
    });

    for (const phrase of ['a one', 'a two', 'a three', 'a four', 'a five']) {
      queue.enqueue(writeback(phrase));
    }

    // A worker Chrome may terminate at any moment cannot hold an unbounded queue; the entries that
    // have already had the most chances to flush are the ones that go.
    expect(queue.size).toBe(3);
    await queue.flush();
    expect(queue.size).toBe(3);
  });

  it('does not lose a mapping enqueued while a failing batch was in flight', async () => {
    const held: { release: (() => void) | null } = { release: null };
    const queue = createWritebackQueue({
      send: () =>
        new Promise<void>((_resolve, reject) => {
          held.release = () => {
            reject(new Error('down'));
          };
        }),
      scheduleInterval: manualInterval().schedule,
      onError: () => undefined,
    });

    queue.enqueue(writeback('in the batch'));
    const inFlight = queue.flush();
    queue.enqueue(writeback('arrived during the request'));
    held.release?.();
    await inFlight;

    expect(queue.size).toBe(2);
  });
});
