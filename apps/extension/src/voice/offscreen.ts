import { createDeepgramAsr } from './deepgram-asr.js';
import { consoleMetricSink } from './metrics.js';
import { parseOffscreenCommand, type OffscreenEvent, type VoiceErrorReason } from './messages.js';
import { createFramer, type Framer } from './framer.js';
import { createVoicePipeline, type VoicePipeline } from './pipeline.js';
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from './config.js';

/**
 * The MV3 offscreen document entrypoint.
 *
 * `getUserMedia` is unavailable in a service worker, so the microphone lives here, in a hidden
 * document the worker creates on demand. This file is the *only* place in the extension that
 * touches audio hardware; everything it feeds — the framer, the VAD, the pipeline — is
 * provider-agnostic logic tested without it.
 *
 * ## Lifecycle
 *
 * The worker sends `start` (with a short-lived ASR token) and `stop`. `start` opens the microphone
 * and the socket; captured audio is framed to 16 kHz and pushed into the pipeline; the pipeline's
 * outward events are relayed to the worker, which forwards the tester-facing ones to the HUD.
 * `stop` finalizes the utterance and releases the microphone. Raw audio never leaves this document
 * and is never written anywhere.
 */

declare const __WISPR_ENV__: string;

const settings: VoiceSettings = DEFAULT_VOICE_SETTINGS;

function emit(event: OffscreenEvent): void {
  // Best-effort: if the worker is asleep the message is dropped, which is fine — the next `start`
  // re-establishes state. Never throw out of the audio path.
  void chrome.runtime.sendMessage(event).catch(() => undefined);
}

let pipeline: VoicePipeline | null = null;
let framer: Framer | null = null;
let stream: MediaStream | null = null;
let audioContext: AudioContext | null = null;

async function start(token: string): Promise<void> {
  if (pipeline !== null) return; // already running

  let media: MediaStream;
  try {
    media = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (error: unknown) {
    emit({ kind: 'error', reason: micErrorReason(error) });
    return;
  }
  stream = media;

  const context = new AudioContext();
  audioContext = context;
  framer = createFramer({ inputSampleRate: context.sampleRate, frameMs: settings.frameMs });

  pipeline = createVoicePipeline({
    asrFactory: () =>
      createDeepgramAsr({
        endpoint: settings.asr.endpoint,
        token,
        model: settings.asr.model,
        language: settings.asr.language,
        endpointingMs: settings.asr.endpointingMs,
      }),
    vadConfig: settings.vad,
    frameMs: settings.frameMs,
    emit,
    metricSink: consoleMetricSink,
  });

  await context.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet.js'));
  const source = context.createMediaStreamSource(media);
  const node = new AudioWorkletNode(context, 'wispr-capture');

  node.port.onmessage = (event: MessageEvent): void => {
    const message = event.data as { kind?: string; samples?: Float32Array };
    if (message.kind !== 'frame' || message.samples === undefined) return;
    for (const frame of framer?.push(message.samples) ?? []) pipeline?.pushFrame(frame);
  };

  source.connect(node);
  // A worklet needs a live graph; route to a zero-gain sink so nothing is played back to the room.
  const silent = context.createGain();
  silent.gain.value = 0;
  node.connect(silent).connect(context.destination);

  pipeline.start();
}

async function stop(): Promise<void> {
  pipeline?.stop();
  pipeline?.dispose();
  pipeline = null;
  framer = null;
  // Release the microphone promptly — the indicator staying lit after a tester stops talking is a
  // trust problem, not a resource one.
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
  await audioContext?.close();
  audioContext = null;
}

function micErrorReason(error: unknown): VoiceErrorReason {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'mic_denied';
  if (name === 'NotFoundError' || name === 'NotReadableError') return 'mic_unavailable';
  return 'internal';
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  const command = parseOffscreenCommand(message);
  if (command === null) return;
  if (command.kind === 'start') void start(command.token);
  else void stop();
});

if (__WISPR_ENV__ !== 'production') {
  console.log(JSON.stringify({ event: 'voice.offscreen_ready', env: __WISPR_ENV__ }));
}
