import { z } from 'zod';

/**
 * The voice pipeline's internal contract.
 *
 * These shapes cross channels *inside the one extension artifact* — offscreen document → service
 * worker → content script — the same as `src/messaging.ts`. They are versioned with the code that
 * ships them, so they live here rather than in `packages/protocol`, which is for payloads crossing
 * between separately-deployed services (CLAUDE.md rule #3 is about *process boundaries between
 * deployables*; these three halves are one deployable).
 *
 * Every hop still parses. The offscreen document, the worker and the content script are separate
 * execution contexts, and a message arriving on any of them is validated before it is trusted.
 *
 * ## What is carried, and what is not
 *
 * Transcript text *is* carried here: it is the tester's own speech, the input to resolution, and
 * held in memory for the session only — never persisted, per this phase's requirement. Raw audio
 * is never carried on any of these channels and never leaves the offscreen document; only the
 * derived VAD level (a single number) and the transcripts do. CLAUDE.md § "PII rule" is about the
 * *application's* content, which none of these messages ever touch.
 */

/** How the tester holds the floor: hold-to-talk, or press-to-toggle. */
export const VoiceMode = z.enum(['push_to_talk', 'toggle']);
export type VoiceMode = z.infer<typeof VoiceMode>;

/**
 * Where the pipeline is, as the HUD is allowed to show it.
 *
 * `dropped` is deliberately a first-class state, not an error: audio was lost because a reconnect
 * outran the 3s buffer, and the tester has to *see* that a word may have gone missing rather than
 * have it swallowed. `reconnecting` is the recoverable case that precedes it.
 */
export const VoicePhase = z.enum([
  'idle', // not listening; microphone closed
  'connecting', // opening the ASR socket
  'listening', // microphone open, connected, VAD gating
  'reconnecting', // socket dropped; backing off and buffering audio
  'dropped', // reconnect outran the buffer; audio was lost — visible, not silent
  'error', // fatal: microphone denied, no token, provider unrecoverable
]);
export type VoicePhase = z.infer<typeof VoicePhase>;

/** Why the pipeline gave up. A closed set so the HUD can phrase each for a tester. */
export const VoiceErrorReason = z.enum([
  'mic_denied', // the tester declined the microphone permission
  'mic_unavailable', // no input device, or getUserMedia is not available here
  'no_token', // no short-lived ASR credential was supplied to start with
  'asr_failed', // the provider closed the socket in a way retries could not recover
  'internal',
]);
export type VoiceErrorReason = z.infer<typeof VoiceErrorReason>;

/**
 * A partial (interim) hypothesis.
 *
 * `revision` is a session-monotonic counter incremented on every partial *and* every final. It is
 * the single fact a downstream consumer needs to detect that a hypothesis has been *revised*: a
 * later message carries a strictly greater revision, so a stale one that arrives out of order — a
 * backgrounded tab draining a queue — can be dropped by comparing the number alone, without
 * diffing the text. The speculation controller in Phase 10 rolls back a class-R effect when a
 * higher revision changes the target; that decision hangs on this number being reliable.
 */
export const PartialHypothesis = z.strictObject({
  kind: z.literal('partial'),
  revision: z.number().int().nonnegative(),
  /** The full hypothesis so far. The unconfirmed tail is everything past the last final. */
  transcript: z.string(),
});
export type PartialHypothesis = z.infer<typeof PartialHypothesis>;

/** The finalized transcript for an utterance, emitted on the provider's endpoint. */
export const FinalTranscript = z.strictObject({
  kind: z.literal('final'),
  revision: z.number().int().nonnegative(),
  transcript: z.string(),
});
export type FinalTranscript = z.infer<typeof FinalTranscript>;

/** The name of the one histogram this phase owns, so the string is written once. */
export const SPEECH_TO_PARTIAL_METRIC = 'wispr_speech_to_partial_ms';

/**
 * Offscreen document → service worker.
 *
 * The offscreen document owns `getUserMedia` (it is unavailable in a service worker) and runs the
 * whole pipeline; it reports outward through these. The worker relays the tester-facing subset to
 * the HUD and records the metric.
 */
export const OffscreenEvent = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('phase'), phase: VoicePhase }),
  /** VAD activity in [0, 1] for the meter. Emitted at frame cadence while listening. */
  z.strictObject({ kind: z.literal('level'), level: z.number().min(0).max(1) }),
  PartialHypothesis,
  FinalTranscript,
  z.strictObject({
    kind: z.literal('metric'),
    name: z.literal(SPEECH_TO_PARTIAL_METRIC),
    valueMs: z.number().nonnegative(),
  }),
  z.strictObject({ kind: z.literal('error'), reason: VoiceErrorReason }),
]);
export type OffscreenEvent = z.infer<typeof OffscreenEvent>;

/**
 * Service worker → offscreen document.
 *
 * `start` carries the short-lived ASR credential and the provider selection: the offscreen
 * document holds no secret of its own and refuses to open a socket without one. The worker mints
 * it (a later phase wires the gateway endpoint) and hands it over per utterance so nothing durable
 * is kept in the page.
 */
export const OffscreenCommand = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('start'),
    /** Opaque, short-lived. Never logged, never persisted. */
    token: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal('stop') }),
]);
export type OffscreenCommand = z.infer<typeof OffscreenCommand>;

/** Parse an event from the offscreen document, or null if it is not one of ours. */
export function parseOffscreenEvent(message: unknown): OffscreenEvent | null {
  const parsed = OffscreenEvent.safeParse(message);
  return parsed.success ? parsed.data : null;
}

/** Parse a command to the offscreen document, or null if it is not one of ours. */
export function parseOffscreenCommand(message: unknown): OffscreenCommand | null {
  const parsed = OffscreenCommand.safeParse(message);
  return parsed.success ? parsed.data : null;
}
