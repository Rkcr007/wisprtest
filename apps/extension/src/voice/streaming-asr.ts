/**
 * The streaming ASR seam.
 *
 * Everything above this line — the pipeline, the VAD, the framer, the HUD — is provider-agnostic.
 * A provider is one implementation of {@link StreamingAsr}, constructed by a {@link StreamingAsrFactory}.
 * Deepgram is the first (`deepgram-asr.ts`); the interface is deliberately the shape a *second*
 * provider drops into, so switching is a factory swap and a config change, not a pipeline rewrite.
 *
 * ## The contract a provider must honour
 *
 * - It streams **16 kHz mono PCM16** frames, exactly what the framer produces. Any provider-side
 *   format negotiation is the implementation's problem, invisible here.
 * - `onPartial` fires for every interim hypothesis; `onFinal` fires once the provider decides an
 *   utterance has ended (its endpointing), or once after `finish()`. A provider that only ever
 *   returns finals is still valid — the pipeline simply has no interim to speculate on.
 * - `finish()` asks the provider to flush a final for the audio sent so far without tearing the
 *   socket down. `close()` tears it down. Keeping them separate is what lets push-to-talk release
 *   commit an utterance while the socket stays warm for the next one.
 * - `onClose` reports every close with `wasClean`, so the pipeline can tell an endpoint (expected)
 *   from a dropped connection (reconnect).
 */

export interface StreamingAsrEvents {
  /** The socket is open and ready for frames. Buffered audio may be flushed now. */
  onOpen(): void;
  /** An interim hypothesis: the best guess so far, subject to revision. */
  onPartial(transcript: string): void;
  /** A finalized transcript for one utterance. */
  onFinal(transcript: string): void;
  /** The socket closed. `wasClean` distinguishes an orderly close from a drop. */
  onClose(info: {
    readonly code: number;
    readonly reason: string;
    readonly wasClean: boolean;
  }): void;
  /** A transport or protocol error. Followed by an `onClose` in practice. */
  onError(error: unknown): void;
}

export interface StreamingAsr {
  /** Open the connection and register callbacks. Idempotent per instance. */
  open(events: StreamingAsrEvents): void;
  /** Send one 16 kHz mono PCM16 frame. A no-op while the socket is not open. */
  send(frame: Int16Array): void;
  /** Ask the provider to finalize the audio sent so far, keeping the socket open. */
  finish(): void;
  /** Tear the connection down. */
  close(): void;
  /** Whether frames sent right now reach the provider. */
  readonly isOpen: boolean;
}

/**
 * Constructs a fresh, unopened {@link StreamingAsr}.
 *
 * A factory rather than a single instance because the reconnect path builds a *new* connection per
 * attempt — a WebSocket cannot be reopened once closed — and because a caller under test supplies a
 * factory that hands out scripted fakes.
 */
export type StreamingAsrFactory = () => StreamingAsr;
