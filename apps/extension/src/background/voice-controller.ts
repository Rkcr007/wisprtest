import type { HudVoice, HudVoiceLine } from '../messaging.js';
import { INITIAL_VOICE } from '../messaging.js';
import { parseOffscreenEvent, type OffscreenCommand } from '../voice/messages.js';

/**
 * The service worker's half of the voice pipeline: it owns the offscreen document and routes
 * between it and the HUD.
 *
 * The offscreen document is a singleton — Chrome permits one per extension — and the microphone is
 * one device, so voice has a single active session at a time: the tab whose tester is holding the
 * key. This tracks that tab's port, distils the offscreen document's event stream into one
 * {@link HudVoice} picture (the same way the attach controller distils token state), and pushes it
 * back to that HUD.
 *
 * ## The credential
 *
 * Starting capture needs a short-lived ASR token. Minting it is injected (`mintToken`): in
 * production the worker gets one from the gateway (a later phase wires that route); locally a
 * developer supplies one at build time. When none is available, `mintToken` returns null and the
 * pipeline is told nothing — instead the HUD is shown a truthful `error` with reason `no_token`,
 * rather than a microphone that opens and streams nowhere. No token is ever logged or persisted.
 */

/** The offscreen document, behind an interface so the controller is testable without `chrome`. */
export interface OffscreenManager {
  /** Create the offscreen document if it does not already exist. */
  ensure(): Promise<void>;
  /** Close it, releasing the microphone and the document. */
  close(): Promise<void>;
  /** Send a command to it. */
  send(command: OffscreenCommand): Promise<void>;
}

/** The parts of a HUD port the controller posts to. */
export interface VoicePort {
  postMessage(message: unknown): void;
}

export interface VoiceControllerOptions {
  readonly offscreen: OffscreenManager;
  /** Returns a short-lived ASR credential, or null when none is configured. */
  readonly mintToken: () => Promise<string | null>;
  /** Where `wispr_speech_to_partial_ms` goes — the worker forwards it to telemetry. */
  readonly onMetric?: (name: string, valueMs: number) => void;
  readonly onError?: (event: string, error: unknown) => void;
}

export interface VoiceController {
  /** The tester engaged push-to-talk on this tab's HUD. */
  start(port: VoicePort): Promise<void>;
  /** The tester released it. */
  stop(port: VoicePort): Promise<void>;
  /** An event arrived from the offscreen document. */
  handleEvent(message: unknown): void;
  /** A tab disconnected; drop it if it held the active session. */
  release(port: VoicePort): void;
}

export function createVoiceController(options: VoiceControllerOptions): VoiceController {
  const { offscreen, mintToken, onMetric, onError } = options;

  let activePort: VoicePort | null = null;
  let state: HudVoice = INITIAL_VOICE;

  function post(next: HudVoice): void {
    state = next;
    if (activePort === null) return;
    try {
      activePort.postMessage(next);
    } catch (error: unknown) {
      // The tab navigated or closed between the event and this push; the disconnect handler will
      // clean it up. Not worth failing a voice session over.
      onError?.('voice.post_failed', error);
    }
  }

  function line(revision: number, text: string): HudVoiceLine {
    return { revision, text };
  }

  return {
    async start(port: VoicePort): Promise<void> {
      // Last start wins: a second tab taking the floor stops the first. Only one microphone.
      activePort = port;
      post({ ...INITIAL_VOICE, phase: 'connecting' });

      let token: string | null;
      try {
        token = await mintToken();
      } catch (error: unknown) {
        onError?.('voice.token_failed', error);
        token = null;
      }
      if (token === null) {
        post({ ...INITIAL_VOICE, phase: 'error' });
        return;
      }

      // The active port may have changed while the token was in flight (the tester released, or
      // another tab took over). Only proceed if this call still owns the session.
      if (activePort !== port) return;

      try {
        await offscreen.ensure();
        await offscreen.send({ kind: 'start', token });
      } catch (error: unknown) {
        onError?.('voice.start_failed', error);
        post({ ...INITIAL_VOICE, phase: 'error' });
      }
    },

    async stop(port: VoicePort): Promise<void> {
      if (activePort !== port) return;
      try {
        await offscreen.send({ kind: 'stop' });
      } catch (error: unknown) {
        onError?.('voice.stop_failed', error);
      }
    },

    handleEvent(message: unknown): void {
      const event = parseOffscreenEvent(message);
      if (event === null) return;

      switch (event.kind) {
        case 'phase':
          // Reaching idle ends the utterance: clear the live level and unconfirmed tail so the HUD
          // does not keep showing a meter for a microphone that is closed.
          if (event.phase === 'idle' || event.phase === 'error') {
            post({ ...state, phase: event.phase, level: 0, partial: null });
            // Release the document on idle so the microphone indicator goes out promptly.
            if (event.phase === 'idle') void offscreen.close().catch(() => undefined);
          } else {
            post({ ...state, phase: event.phase });
          }
          return;
        case 'level':
          post({ ...state, level: event.level });
          return;
        case 'partial':
          post({ ...state, partial: line(event.revision, event.transcript) });
          return;
        case 'final':
          // The final becomes the confirmed line; the unconfirmed tail is cleared.
          post({ ...state, final: line(event.revision, event.transcript), partial: null });
          return;
        case 'metric':
          onMetric?.(event.name, event.valueMs);
          return;
        case 'error':
          post({ ...state, phase: 'error', level: 0, partial: null });
          return;
      }
    },

    release(port: VoicePort): void {
      if (activePort !== port) return;
      activePort = null;
      state = INITIAL_VOICE;
      void offscreen.close().catch(() => undefined);
    },
  };
}
