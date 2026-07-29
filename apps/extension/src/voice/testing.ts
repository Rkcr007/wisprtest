import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { StreamingAsr, StreamingAsrEvents, StreamingAsrFactory } from './streaming-asr.js';

/**
 * The deterministic voice harness the phase requires: a fake {@link StreamingAsr} that replays a
 * scripted sequence — including at least one revision — and a loader for the recorded PCM fixture.
 *
 * Not a `.test.ts`, so vitest does not run it; never imported by an entrypoint, so the bundler
 * never ships it. It exists so this phase and every downstream one (speculation, T2, sessions) can
 * drive the pipeline through a known partial-then-revision-then-final sequence without a
 * microphone, a network, or a provider account.
 */

export interface FakeAsrController {
  readonly asr: StreamingAsr;
  /** Every frame the pipeline sent while the socket was open, in order. */
  readonly sent: Int16Array[];
  readonly counts: { finish: number; close: number; open: number };
  fireOpen(): void;
  firePartial(transcript: string): void;
  fireFinal(transcript: string): void;
  fireClose(info?: { code?: number; reason?: string; wasClean?: boolean }): void;
  fireError(error?: unknown): void;
}

/**
 * A hand-driven fake connection. `autoOpen` fires `onOpen` synchronously from `open()` for the
 * common happy path; leave it false to test the socket-opening window.
 */
export function createFakeAsr(options: { autoOpen?: boolean } = {}): FakeAsrController {
  const sent: Int16Array[] = [];
  const counts = { finish: 0, close: 0, open: 0 };
  let events: StreamingAsrEvents | null = null;
  let open = false;

  const controller: FakeAsrController = {
    sent,
    counts,
    fireOpen(): void {
      open = true;
      counts.open += 1;
      events?.onOpen();
    },
    firePartial(transcript: string): void {
      events?.onPartial(transcript);
    },
    fireFinal(transcript: string): void {
      events?.onFinal(transcript);
    },
    fireClose(info = {}): void {
      open = false;
      events?.onClose({
        code: info.code ?? 1000,
        reason: info.reason ?? '',
        wasClean: info.wasClean ?? true,
      });
    },
    fireError(error?: unknown): void {
      events?.onError(error);
    },
    asr: {
      open(handlers: StreamingAsrEvents): void {
        events = handlers;
        if (options.autoOpen === true) controller.fireOpen();
      },
      send(frame: Int16Array): void {
        if (open) sent.push(frame);
      },
      finish(): void {
        counts.finish += 1;
      },
      close(): void {
        open = false;
        counts.close += 1;
      },
      get isOpen(): boolean {
        return open;
      },
    },
  };

  return controller;
}

/** A factory that hands out fresh fakes and records them, so a reconnect test can drive attempt N. */
export function createFakeAsrFactory(options: { autoOpen?: boolean } = {}): {
  factory: StreamingAsrFactory;
  instances: FakeAsrController[];
} {
  const instances: FakeAsrController[] = [];
  return {
    instances,
    factory: (): StreamingAsr => {
      const controller = createFakeAsr(options);
      instances.push(controller);
      return controller.asr;
    },
  };
}

/**
 * A scripted utterance with a genuine revision in it: "pending" is first misheard as "bending" and
 * corrected on the next partial. Downstream detects the revision by the revision *number* alone,
 * but the text change is what makes it a real one to detect.
 */
export const SCRIPTED_UTTERANCE = {
  partials: [
    'show',
    'show me',
    'show me the bending', // misheard
    'show me the pending', // revised — the correction
    'show me the pending orders',
  ],
  final: 'show me the pending orders',
} as const;

/**
 * Load the recorded 16 kHz mono PCM16 fixture as fixed-size frames.
 *
 * The fixture is headerless little-endian Int16 at 16 kHz (see `scripts/make-voice-fixture.ts`),
 * shaped silence → speech → silence so the VAD has both to gate between. A trailing partial frame,
 * if any, is dropped — the framer does the same with live audio.
 */
export function loadFixtureFrames(frameSize: number): Int16Array[] {
  const path = fileURLToPath(
    new URL('../../test/fixtures/voice/utterance-16k-mono.pcm', import.meta.url),
  );
  const bytes = readFileSync(path);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));

  const frames: Int16Array[] = [];
  for (let offset = 0; offset + frameSize <= samples.length; offset += frameSize) {
    frames.push(samples.slice(offset, offset + frameSize));
  }
  return frames;
}

/** Split loaded frames into their silent lead-in and the speech body, by VAD-relevant energy. */
export function fixtureRegions(frames: Int16Array[]): {
  frames: Int16Array[];
  speechFrameCount: number;
} {
  let speechFrameCount = 0;
  for (const frame of frames) {
    let sumSquares = 0;
    for (const sample of frame) {
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / frame.length);
    if (rms > 800) speechFrameCount += 1;
  }
  return { frames, speechFrameCount };
}
