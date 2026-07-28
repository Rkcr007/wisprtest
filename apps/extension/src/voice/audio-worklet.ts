/**
 * The audio-capture worklet.
 *
 * Runs on the audio rendering thread inside the offscreen document, where it receives the
 * microphone in 128-sample quanta and posts each quantum's mono `Float32` to the offscreen main
 * thread. Capturing here rather than in a `ScriptProcessorNode` on the main thread is what keeps
 * frames from being dropped when the main thread is busy — a dropped frame is a clipped word.
 *
 * It is deliberately tiny and import-free: worklet modules load in a scope with no module system,
 * and it does no framing, resampling or VAD — all of that is the offscreen main thread's job
 * (`framer.ts`, `pipeline.ts`), which is where it can be unit-tested. This only moves samples.
 *
 * Built to `dist/audio-worklet.js` and loaded with `audioContext.audioWorklet.addModule` at a
 * `chrome-extension://` URL; an extension page may load its own resources, so it needs no
 * `web_accessible_resources` entry.
 */

// The worklet global scope's ambient types are not in the standard DOM lib; declare the minimum.
declare const registerProcessor: (name: string, processor: unknown) => void;
declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  abstract process(inputs: Float32Array[][]): boolean;
}

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Announce the hardware rate once, so the main thread configures the framer's resampler.
    this.port.postMessage({ kind: 'rate', sampleRate });
  }

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel !== undefined && channel.length > 0) {
      // Copy: the input buffer is reused by the graph after this call returns, so a reference
      // posted across the port would be overwritten before the main thread read it.
      this.port.postMessage({ kind: 'frame', samples: channel.slice() });
    }
    // Keep the processor alive; returning false would let the runtime garbage-collect it.
    return true;
  }
}

registerProcessor('wispr-capture', CaptureProcessor);
