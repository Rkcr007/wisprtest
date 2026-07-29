/**
 * The voice pipeline (docs/BUILD-PLAN.md Phase 9).
 *
 * Push-to-talk capture in an MV3 offscreen document, VAD-gated streaming to a pluggable ASR
 * provider, and `PartialHypothesis` / `FinalTranscript` events the HUD and later phases consume.
 *
 * The hot-path core — VAD, framer, reconnect/buffer, revision numbering, the metric — is
 * provider- and browser-agnostic and lives behind `createVoicePipeline`; `offscreen.ts` is the one
 * place that touches audio hardware, and `createHotkey` runs in the content script.
 */

export {
  VoiceMode,
  VoicePhase,
  VoiceErrorReason,
  PartialHypothesis,
  FinalTranscript,
  OffscreenEvent,
  OffscreenCommand,
  parseOffscreenEvent,
  parseOffscreenCommand,
  SPEECH_TO_PARTIAL_METRIC,
} from './messages.js';
export { createVoicePipeline, type VoicePipeline, type PipelineConfig } from './pipeline.js';
export { createHotkey, type Hotkey, type HotkeyConfig, type HotkeyHandlers } from './hotkey.js';
export { createVad, DEFAULT_VAD_CONFIG, type Vad, type VadConfig } from './vad.js';
export { createFramer, type Framer, type FramerConfig } from './framer.js';
export {
  createRingBuffer,
  backoffDelay,
  DEFAULT_BACKOFF,
  type RingBuffer,
  type BackoffConfig,
} from './reconnect.js';
export {
  createDeepgramAsr,
  type DeepgramConfig,
  type SocketLike,
  type SocketFactory,
} from './deepgram-asr.js';
export type { StreamingAsr, StreamingAsrEvents, StreamingAsrFactory } from './streaming-asr.js';
export { createMetrics, consoleMetricSink, type Metrics, type MetricSink } from './metrics.js';
export { DEFAULT_VOICE_SETTINGS, type VoiceSettings, type AsrProviderConfig } from './config.js';
