import type { VoiceMode } from './messages.js';
import { DEFAULT_VAD_CONFIG, type VadConfig } from './vad.js';

/**
 * The tester-configurable voice settings, and their defaults.
 *
 * Held here as one shape so the content script (which owns the hotkey) and the offscreen document
 * (which owns capture and the provider) read the same record rather than two drifting copies. A
 * later phase persists edits through the console; this phase defines the contract and ships
 * defaults chosen for an open office.
 *
 * The ASR endpoint and model are configuration, never constants — the provider is a per-deployment
 * choice, and a second provider drops in by changing `provider` and this block.
 */

export interface AsrProviderConfig {
  readonly provider: 'deepgram';
  /** e.g. `wss://api.deepgram.com/v1/listen`. */
  readonly endpoint: string;
  readonly model: string;
  readonly language: string;
  readonly endpointingMs: number;
}

export interface VoiceSettings {
  readonly mode: VoiceMode;
  /** Keys held together to talk, as `KeyboardEvent.key` values. */
  readonly hotkeyKeys: readonly string[];
  readonly vad: VadConfig;
  readonly asr: AsrProviderConfig;
  /** Frame length in ms shared by the framer, VAD and buffer bound. */
  readonly frameMs: number;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  // Hold-to-talk by default: the safe choice in a shared room, where a latched-open microphone is
  // the failure that matters. Toggle is available for testers who prefer it.
  mode: 'push_to_talk',
  // Control+Space held: two modifiers with no printable character, so holding them inserts nothing
  // into the app under test even when a text field has focus.
  hotkeyKeys: ['Control', ' '],
  vad: DEFAULT_VAD_CONFIG,
  asr: {
    provider: 'deepgram',
    endpoint: 'wss://api.deepgram.com/v1/listen',
    model: 'nova-2',
    language: 'en-US',
    endpointingMs: 300,
  },
  frameMs: 20,
};
