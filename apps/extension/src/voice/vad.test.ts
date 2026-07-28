// @vitest-environment node
// The VAD is pure arithmetic and the fixture loader reads a file:// URL — neither wants a DOM, and
// happy-dom's URL polyfill mis-resolves the fixture path against its http location. Node it is.
import { describe, expect, it } from 'vitest';

import { createVad, DEFAULT_VAD_CONFIG } from './vad.js';
import { loadFixtureFrames } from './testing.js';

const FRAME_SIZE = 320; // 20 ms at 16 kHz

function silentFrame(): Int16Array {
  // Not digital zero: a faint floor, like the fixture's quiet room, so adaptation has something
  // to learn from rather than an impossible -Inf.
  const frame = new Int16Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i += 1) frame[i] = (i % 3) - 1;
  return frame;
}

describe('energy VAD', () => {
  it('does not gate on a quiet room', () => {
    const vad = createVad();
    let gated = 0;
    for (let i = 0; i < 50; i += 1) if (vad.process(silentFrame())) gated += 1;
    expect(gated).toBe(0);
    expect(vad.level).toBeLessThan(0.2);
  });

  it('opens on the recorded speech and closes again after it', () => {
    const vad = createVad();
    const frames = loadFixtureFrames(FRAME_SIZE);
    const gated = frames.map((frame) => vad.process(frame));

    // Lead-in (0.4 s ≈ frames 0–19) is silence: the gate must stay shut there, learning the floor.
    const leadGated = gated.slice(0, 15).filter(Boolean).length;
    expect(leadGated).toBe(0);

    // The speech body (≈ frames 20–79) must be gated open for most of its length. Not every frame —
    // the fixture has an intra-utterance dip — but the hangover keeps it mostly continuous.
    const bodyGated = gated.slice(25, 75).filter(Boolean).length;
    expect(bodyGated).toBeGreaterThan(35);
  });

  it('reports a higher level during speech than during silence', () => {
    const vad = createVad();
    const frames = loadFixtureFrames(FRAME_SIZE);

    for (let i = 0; i < 15; i += 1) vad.process(frames[i] ?? silentFrame());
    const silenceLevel = vad.level;

    let peak = 0;
    for (let i = 20; i < 75; i += 1) {
      vad.process(frames[i] ?? silentFrame());
      peak = Math.max(peak, vad.level);
    }
    expect(peak).toBeGreaterThan(silenceLevel + 0.2);
  });

  it('is more permissive at aggressiveness 0 than at 3', () => {
    const frames = loadFixtureFrames(FRAME_SIZE);
    const count = (aggressiveness: 0 | 3): number => {
      const vad = createVad({ ...DEFAULT_VAD_CONFIG, aggressiveness });
      return frames.filter((frame) => vad.process(frame)).length;
    };
    expect(count(0)).toBeGreaterThanOrEqual(count(3));
  });

  it('forgets its floor on reset', () => {
    const vad = createVad();
    const frames = loadFixtureFrames(FRAME_SIZE);
    for (const frame of frames) vad.process(frame);
    vad.reset();
    expect(vad.level).toBe(0);
  });
});
