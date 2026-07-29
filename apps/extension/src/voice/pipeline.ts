import { createMetrics, type Metrics, type MetricSink } from './metrics.js';
import {
  SPEECH_TO_PARTIAL_METRIC,
  type OffscreenEvent,
  type VoiceErrorReason,
  type VoicePhase,
} from './messages.js';
import {
  backoffDelay,
  createRingBuffer,
  DEFAULT_BACKOFF,
  type BackoffConfig,
  type RingBuffer,
} from './reconnect.js';
import type { StreamingAsr, StreamingAsrEvents, StreamingAsrFactory } from './streaming-asr.js';
import { createVad, DEFAULT_VAD_CONFIG, type Vad, type VadConfig } from './vad.js';

/**
 * The voice pipeline — the provider-agnostic core that turns 16 kHz frames into hypotheses.
 *
 * It is **push-driven and free of any audio API**: the offscreen document feeds it frames it has
 * already captured and framed (`offscreen.ts`), and a test feeds it frames from a recorded fixture.
 * Everything the phase requires that is *logic* rather than *plumbing* lives here — the VAD gate,
 * revision numbering, the `wispr_speech_to_partial_ms` measurement, and the reconnect/buffer state
 * machine — so all of it is exercised deterministically against a scripted `StreamingAsr`.
 *
 * ## The state machine
 *
 * ```
 *            start()                 onOpen              finish()/stop()
 *   idle ───────────► connecting ───────────► listening ───────────────► idle
 *     ▲                   │                       │  ▲
 *     │ error / stop      │ frames buffered       │  │ onOpen, buffer flushed
 *     │                   ▼                       ▼  │
 *     └──────────────  (buffering) ◄──── reconnecting ──► dropped (buffer overran 3 s)
 *                      backoff schedule
 * ```
 *
 * While `connecting`, `reconnecting` or `dropped`, speech frames go to the ring buffer instead of
 * the wire; on the next `onOpen` the buffer is flushed in order. The buffer is bounded at 3 s — its
 * `push` reporting a drop is what moves the pipeline into the visible `dropped` state rather than
 * losing audio in silence.
 *
 * ## Never persisted
 *
 * Frames live only in the ring buffer, in memory, and are cleared on stop. Transcripts are emitted
 * outward and held nowhere here. Nothing in this file touches storage.
 */

export interface PipelineConfig {
  readonly asrFactory: StreamingAsrFactory;
  readonly emit: (event: OffscreenEvent) => void;

  readonly vad?: Vad;
  readonly vadConfig?: VadConfig;
  readonly metricSink?: MetricSink;

  /** Frame length in ms, so the buffer's 3 s bound is converted to a frame count. */
  readonly frameMs?: number;
  readonly bufferMaxMs?: number;
  readonly backoff?: BackoffConfig;
  /** Attempts before the pipeline gives up and reports `asr_failed`. */
  readonly maxReconnectAttempts?: number;

  /** Injected clock and scheduler, so tests drive time deterministically. */
  readonly now?: () => number;
  readonly schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly cancel?: (handle: ReturnType<typeof setTimeout>) => void;
  readonly random?: () => number;
}

export interface VoicePipeline {
  /** Begin an utterance: open the connection and start gating frames. */
  start(): void;
  /** Feed one 16 kHz mono PCM16 frame. */
  pushFrame(frame: Int16Array): void;
  /** End the utterance: flush a final, then return to idle. */
  stop(): void;
  /** The pipeline's current phase, as reported outward. */
  readonly phase: VoicePhase;
  /** Tear everything down. */
  dispose(): void;
}

const DEFAULT_FRAME_MS = 20;
const DEFAULT_BUFFER_MAX_MS = 3_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 6;

export function createVoicePipeline(config: PipelineConfig): VoicePipeline {
  const now = config.now ?? defaultNow;
  const schedule = config.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel =
    config.cancel ??
    ((handle) => {
      clearTimeout(handle);
    });
  const random = config.random ?? Math.random;
  const frameMs = config.frameMs ?? DEFAULT_FRAME_MS;
  const backoff = config.backoff ?? DEFAULT_BACKOFF;
  const maxReconnectAttempts = config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;

  const vad: Vad = config.vad ?? createVad(config.vadConfig ?? DEFAULT_VAD_CONFIG);
  const metrics: Metrics = createMetrics(config.metricSink ?? (() => undefined));
  const buffer: RingBuffer = createRingBuffer({
    maxMs: config.bufferMaxMs ?? DEFAULT_BUFFER_MAX_MS,
    frameMs,
  });

  let phase: VoicePhase = 'idle';
  let asr: StreamingAsr | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;

  // A session-monotonic revision, incremented on every partial and every final — the number a
  // downstream consumer compares to detect a revision (see messages.ts).
  let revision = 0;
  // Onset of the current utterance's speech, and whether its first partial has been timed yet.
  // Both reset per utterance so each utterance measures its own speech-to-partial latency.
  let onsetAt: number | null = null;
  let firstPartialTimed = false;
  // Set between stop() and the final that closes the utterance, so a final arriving after the
  // tester released the key returns the pipeline to idle.
  let stopping = false;

  function setPhase(next: VoicePhase): void {
    if (phase === next) return;
    phase = next;
    config.emit({ kind: 'phase', phase: next });
  }

  function fail(reason: VoiceErrorReason): void {
    teardownConnection();
    buffer.clear();
    config.emit({ kind: 'error', reason });
    setPhase('error');
  }

  function teardownConnection(): void {
    if (reconnectTimer !== null) {
      cancel(reconnectTimer);
      reconnectTimer = null;
    }
    if (asr !== null) {
      asr.close();
      asr = null;
    }
  }

  const events: StreamingAsrEvents = {
    onOpen(): void {
      attempts = 0;
      // Flush anything captured while the socket was down or opening, in order, then resume live.
      for (const frame of buffer.drain()) asr?.send(frame);
      if (!stopping) setPhase('listening');
    },

    onPartial(transcript: string): void {
      revision += 1;
      config.emit({ kind: 'partial', revision, transcript });
      if (onsetAt !== null && !firstPartialTimed) {
        firstPartialTimed = true;
        metrics.observeMs(SPEECH_TO_PARTIAL_METRIC, now() - onsetAt);
        config.emit({
          kind: 'metric',
          name: SPEECH_TO_PARTIAL_METRIC,
          valueMs: Math.max(0, now() - onsetAt),
        });
      }
    },

    onFinal(transcript: string): void {
      revision += 1;
      config.emit({ kind: 'final', revision, transcript });
      // A new utterance may follow on the same warm socket, so re-arm the per-utterance timers.
      onsetAt = null;
      firstPartialTimed = false;
      if (stopping) goIdle();
    },

    onClose(info): void {
      if (stopping) {
        goIdle();
        return;
      }
      // An unexpected drop while listening or opening. Reconnect with backoff, buffering meanwhile.
      if (phase === 'listening' || phase === 'connecting' || phase === 'reconnecting') {
        asr = null;
        scheduleReconnect();
      } else if (!info.wasClean) {
        asr = null;
      }
    },

    onError(): void {
      // Errors are always followed by a close in practice; the close drives the reconnect. Nothing
      // to do here but avoid surfacing the raw error object, which can carry request detail.
    },
  };

  function openConnection(): void {
    asr = config.asrFactory();
    asr.open(events);
  }

  function scheduleReconnect(): void {
    attempts += 1;
    if (attempts > maxReconnectAttempts) {
      fail('asr_failed');
      return;
    }
    setPhase('reconnecting');
    const delay = backoffDelay(attempts - 1, backoff, random);
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      openConnection();
    }, delay);
  }

  function goIdle(): void {
    teardownConnection();
    buffer.clear();
    vad.reset();
    onsetAt = null;
    firstPartialTimed = false;
    stopping = false;
    attempts = 0;
    setPhase('idle');
  }

  return {
    start(): void {
      if (phase !== 'idle' && phase !== 'error') return;
      stopping = false;
      attempts = 0;
      revision = 0;
      onsetAt = null;
      firstPartialTimed = false;
      vad.reset();
      buffer.clear();
      setPhase('connecting');
      openConnection();
    },

    pushFrame(frame: Int16Array): void {
      if (phase === 'idle' || phase === 'error') return;

      // Run the VAD on every frame so its noise floor keeps adapting and the meter keeps moving,
      // but only speech frames are forwarded or buffered.
      const isSpeech = vad.process(frame);
      config.emit({ kind: 'level', level: vad.level });
      if (!isSpeech) return;

      onsetAt ??= now();

      if (phase === 'listening' && asr?.isOpen === true) {
        asr.send(frame);
        return;
      }
      // Socket not live: buffer, bounded at 3 s. A drop surfaces as the visible `dropped` state —
      // whether the socket is still opening or mid-reconnect, an overrun is one the tester must see.
      if (buffer.push(frame)) setPhase('dropped');
    },

    stop(): void {
      if (phase === 'idle' || phase === 'error') {
        goIdle();
        return;
      }
      stopping = true;
      if (asr?.isOpen === true) {
        // Ask for a final on the audio sent so far, keeping the socket open; `onFinal` then idles.
        asr.finish();
      } else {
        // Nothing open to flush (still connecting, or mid-reconnect). Drop straight to idle.
        goIdle();
      }
    },

    get phase(): VoicePhase {
      return phase;
    },

    dispose(): void {
      goIdle();
    },
  };
}

function defaultNow(): number {
  return typeof performance === 'object' ? performance.now() : Date.now();
}
