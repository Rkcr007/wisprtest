import { describe, expect, it } from 'vitest';

import { createFramer } from './framer.js';

describe('framer', () => {
  it('reframes at the native rate and converts to PCM16', () => {
    const framer = createFramer({ inputSampleRate: 16_000, frameMs: 20 });
    expect(framer.frameSize).toBe(320);

    const chunk = new Float32Array(320);
    chunk[0] = 1; // full scale positive
    chunk[1] = -1; // full scale negative
    chunk[2] = 0;

    const [frame] = framer.push(chunk);
    expect(frame).toBeInstanceOf(Int16Array);
    expect(frame).toHaveLength(320);
    expect(frame?.[0]).toBe(32767);
    expect(frame?.[1]).toBe(-32768);
    expect(frame?.[2]).toBe(0);
  });

  it('clamps samples that overshoot [-1, 1] instead of wrapping', () => {
    const framer = createFramer({ inputSampleRate: 16_000, frameMs: 20 });
    const chunk = new Float32Array(320);
    chunk[0] = 1.5; // a resampler overshoot
    chunk[1] = -1.5;

    const [frame] = framer.push(chunk);
    expect(frame?.[0]).toBe(32767);
    expect(frame?.[1]).toBe(-32768);
  });

  it('holds a remainder across calls so no partial frame is dropped at a chunk boundary', () => {
    const framer = createFramer({ inputSampleRate: 16_000, frameMs: 20 });
    expect(framer.push(new Float32Array(319))).toHaveLength(0); // one short of a frame
    const frames = framer.push(new Float32Array(1)); // completes it
    expect(frames).toHaveLength(1);
  });

  it('downsamples 48 kHz to 16 kHz, carrying the read position across chunks', () => {
    const framer = createFramer({ inputSampleRate: 48_000, frameMs: 20 });
    expect(framer.frameSize).toBe(320);

    // 480 input samples at 48 kHz is 10 ms → 160 output samples, half a 20 ms frame. Two of them
    // complete exactly one frame only if the resampler is continuous across the seam.
    expect(framer.push(new Float32Array(480))).toHaveLength(0);
    const frames = framer.push(new Float32Array(480));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(320);
  });

  it('drops its remainder on reset', () => {
    const framer = createFramer({ inputSampleRate: 16_000, frameMs: 20 });
    framer.push(new Float32Array(200));
    framer.reset();
    expect(framer.push(new Float32Array(120))).toHaveLength(0); // 120, not 320 — the 200 is gone
  });

  it('rejects a non-positive configuration', () => {
    expect(() => createFramer({ inputSampleRate: 0, frameMs: 20 })).toThrow();
    expect(() => createFramer({ inputSampleRate: 16_000, frameMs: 0 })).toThrow();
  });
});
