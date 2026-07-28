import { describe, expect, it } from 'vitest';

import { backoffDelay, createRingBuffer, type BackoffConfig } from './reconnect.js';

function frame(tag: number): Int16Array {
  return Int16Array.of(tag);
}

describe('ring buffer', () => {
  it('derives its capacity from the millisecond bound', () => {
    const buffer = createRingBuffer({ maxMs: 3_000, frameMs: 20 });
    for (let i = 0; i < 150; i += 1) expect(buffer.push(frame(i))).toBe(false);
    expect(buffer.size).toBe(150); // 3000 / 20
    expect(buffer.push(frame(150))).toBe(true); // the 151st overruns 3 s
  });

  it('drops the oldest and keeps the newest when full — never silently', () => {
    const buffer = createRingBuffer({ maxMs: 40, frameMs: 20 }); // capacity 2
    expect(buffer.push(frame(1))).toBe(false);
    expect(buffer.push(frame(2))).toBe(false);
    expect(buffer.push(frame(3))).toBe(true); // reports the drop rather than hiding it
    expect(buffer.drain()).toEqual([frame(2), frame(3)]);
  });

  it('drains in order and empties', () => {
    const buffer = createRingBuffer({ maxMs: 100, frameMs: 20 });
    buffer.push(frame(1));
    buffer.push(frame(2));
    expect(buffer.drain()).toEqual([frame(1), frame(2)]);
    expect(buffer.size).toBe(0);
    expect(buffer.drain()).toEqual([]);
  });

  it('clears', () => {
    const buffer = createRingBuffer({ maxMs: 100, frameMs: 20 });
    buffer.push(frame(1));
    buffer.clear();
    expect(buffer.size).toBe(0);
  });
});

describe('backoff schedule', () => {
  const exact: BackoffConfig = { baseMs: 250, maxMs: 8_000, factor: 2, jitter: 0 };

  it('grows exponentially and caps at maxMs when jitter is off', () => {
    expect(backoffDelay(0, exact)).toBe(250);
    expect(backoffDelay(1, exact)).toBe(500);
    expect(backoffDelay(2, exact)).toBe(1_000);
    expect(backoffDelay(3, exact)).toBe(2_000);
    expect(backoffDelay(10, exact)).toBe(8_000); // capped
  });

  it('spreads within a jittered window bounded by the pinned random source', () => {
    const jittered: BackoffConfig = { ...exact, jitter: 0.2 };
    // random() = 0 sits at the floor of the window (capped - jitter*capped); random() = 1 at the top.
    expect(backoffDelay(0, jittered, () => 0)).toBe(200);
    expect(backoffDelay(0, jittered, () => 1)).toBe(250);
    const mid = backoffDelay(0, jittered, () => 0.5);
    expect(mid).toBeGreaterThanOrEqual(200);
    expect(mid).toBeLessThanOrEqual(250);
  });
});
