/**
 * Turns the microphone's stream into the fixed frames the VAD and ASR expect.
 *
 * A `MediaStream` sampled through an `AudioContext` arrives as `Float32` in [-1, 1] at the
 * hardware's rate (usually 44.1 or 48 kHz) in whatever chunk size the audio graph hands us
 * (128 samples per worklet quantum). Both the VAD and every streaming ASR here want **16 kHz mono
 * PCM16 in fixed-length frames**. This does the two conversions and the reframing, holding a
 * remainder between calls so no partial frame is dropped at a chunk boundary.
 *
 * Kept free of any audio API: it takes `Float32Array` in and gives `Int16Array` out, so it is
 * exercised in a unit test with generated buffers rather than a live graph.
 */

const TARGET_RATE = 16_000;

export interface FramerConfig {
  /** Sample rate of the incoming audio, e.g. the `AudioContext.sampleRate`. */
  readonly inputSampleRate: number;
  /** Frame length in milliseconds. 20 ms → 320 samples at 16 kHz. */
  readonly frameMs: number;
}

export interface Framer {
  /** Feed a chunk of `Float32` samples in [-1, 1]; get back every whole 16 kHz frame it completed. */
  push(chunk: Float32Array): Int16Array[];
  /** Samples per output frame. */
  readonly frameSize: number;
  /** Drop any buffered remainder. Called when capture stops so a new utterance starts clean. */
  reset(): void;
}

function toPcm16(sample: number): number {
  // Clamp before scaling: a resampler can overshoot [-1, 1] slightly, and a wrap from 32767 to
  // -32768 is an audible click the ASR would hear as a transient.
  const clamped = Math.min(1, Math.max(-1, sample));
  return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
}

export function createFramer(config: FramerConfig): Framer {
  if (config.inputSampleRate <= 0) throw new Error('inputSampleRate must be positive');
  if (config.frameMs <= 0) throw new Error('frameMs must be positive');

  const frameSize = Math.round((TARGET_RATE * config.frameMs) / 1000);
  const ratio = config.inputSampleRate / TARGET_RATE;

  // Carries samples that did not fill a frame, and — when downsampling — the fractional read
  // position within the input so resampling is continuous across chunk boundaries rather than
  // restarting each call and clicking at the seam.
  let pending: number[] = [];
  let readPos = 0;

  function resample(chunk: Float32Array): number[] {
    if (ratio === 1) return Array.from(chunk);

    // Linear interpolation. Not a polyphase FIR — for a VAD gate and an ASR that band-limits its
    // own features, linear resampling is adequate and cheap, and the alternative is a filter design
    // this hot path does not need. `readPos` persists across chunks; we consume it down as we go.
    const out: number[] = [];
    while (readPos < chunk.length) {
      const base = Math.floor(readPos);
      const frac = readPos - base;
      const a = chunk[base] ?? 0;
      const b = chunk[base + 1] ?? a;
      out.push(a + (b - a) * frac);
      readPos += ratio;
    }
    // Keep the fractional offset into the next chunk; the integer part is consumed.
    readPos -= chunk.length;
    return out;
  }

  return {
    frameSize,

    push(chunk: Float32Array): Int16Array[] {
      const resampled = resample(chunk);
      for (const sample of resampled) pending.push(sample);

      const frames: Int16Array[] = [];
      while (pending.length >= frameSize) {
        const slice = pending.slice(0, frameSize);
        pending = pending.slice(frameSize);
        const frame = new Int16Array(frameSize);
        for (let i = 0; i < frameSize; i += 1) frame[i] = toPcm16(slice[i] ?? 0);
        frames.push(frame);
      }
      return frames;
    },

    reset(): void {
      pending = [];
      readPos = 0;
    },
  };
}
