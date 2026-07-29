import { describe, expect, it } from 'vitest';

import { SPEECH_TO_PARTIAL_METRIC, type OffscreenEvent } from './messages.js';
import type { MetricSample } from './metrics.js';
import { createVoicePipeline } from './pipeline.js';
import { createFakeAsr, createFakeAsrFactory, SCRIPTED_UTTERANCE } from './testing.js';
import type { Vad } from './vad.js';

/**
 * The deterministic voice harness the phase requires: a scripted {@link StreamingAsr} replaying a
 * partial → revision → final sequence, a stubbed VAD so gating is not the thing under test, and an
 * injected clock so `wispr_speech_to_partial_ms` is exact. No microphone, no socket, no timers.
 */

const FRAME_SIZE = 320; // 20 ms at 16 kHz

function speechFrame(): Int16Array {
  return new Int16Array(FRAME_SIZE);
}

/** A VAD that reports every frame as speech, at a fixed level — the gate is tested in vad.test.ts. */
function alwaysSpeech(level = 0.6): Vad {
  return { process: () => true, level, reset: () => undefined };
}

function neverSpeech(): Vad {
  return { process: () => false, level: 0, reset: () => undefined };
}

/** No emitted event may carry raw audio outward — only the derived level and the transcripts do. */
function carriesAudio(event: OffscreenEvent): boolean {
  return Object.values(event as Record<string, unknown>).some(
    (value) =>
      value instanceof Int16Array || value instanceof Float32Array || value instanceof ArrayBuffer,
  );
}

describe('voice pipeline — scripted utterance', () => {
  it('replays partials with monotonic revisions, times one metric, and finalizes', () => {
    const asr = createFakeAsr({ autoOpen: true });
    const events: OffscreenEvent[] = [];
    const metrics: MetricSample[] = [];
    let clock = 1_000;

    const pipeline = createVoicePipeline({
      asrFactory: () => asr.asr,
      emit: (event) => events.push(event),
      vad: alwaysSpeech(),
      metricSink: (sample) => metrics.push(sample),
      now: () => clock,
    });

    pipeline.start();
    // autoOpen fired onOpen synchronously from open(): the socket is live.
    expect(pipeline.phase).toBe('listening');

    // One speech frame sets the utterance onset before any hypothesis arrives, then 40 ms pass.
    pipeline.pushFrame(speechFrame());
    expect(asr.sent).toHaveLength(1);
    clock += 40;

    for (const partial of SCRIPTED_UTTERANCE.partials) asr.firePartial(partial);
    pipeline.stop();
    asr.fireFinal(SCRIPTED_UTTERANCE.final);

    // stop() asked the provider to flush a final, keeping the socket warm, then the final idled us.
    expect(asr.counts.finish).toBe(1);
    expect(pipeline.phase).toBe('idle');

    // Revisions strictly increase across every partial AND the final — the number downstream trusts.
    const revisions = events
      .filter((e): e is Extract<OffscreenEvent, { revision: number }> => 'revision' in e)
      .map((e) => e.revision);
    expect(revisions).toEqual([1, 2, 3, 4, 5, 6]);

    // A genuine revision: "bending" was corrected to "pending" at a strictly greater revision.
    const misheard = events.find(
      (e) => e.kind === 'partial' && e.transcript === 'show me the bending',
    );
    const corrected = events.find(
      (e) => e.kind === 'partial' && e.transcript === 'show me the pending',
    );
    expect(misheard?.kind === 'partial' && corrected?.kind === 'partial').toBe(true);
    if (misheard?.kind === 'partial' && corrected?.kind === 'partial') {
      expect(corrected.revision).toBeGreaterThan(misheard.revision);
    }

    // Exactly one final, carrying the finalized transcript.
    const finals = events.filter((e) => e.kind === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ transcript: SCRIPTED_UTTERANCE.final });

    // wispr_speech_to_partial_ms recorded once, from onset to the first partial (40 ms).
    expect(metrics).toEqual([{ name: SPEECH_TO_PARTIAL_METRIC, valueMs: 40 }]);
    const metricEvents = events.filter((e) => e.kind === 'metric');
    expect(metricEvents).toHaveLength(1);

    // The phase trajectory the HUD sees: idle → connecting → listening → idle.
    const phases = events
      .filter((e) => e.kind === 'phase')
      .map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['connecting', 'listening', 'idle']);

    // Never persist / never leak raw audio: no emitted event carries a buffer.
    expect(events.some(carriesAudio)).toBe(false);
  });

  it('does not time a metric or forward audio when the VAD stays shut', () => {
    const asr = createFakeAsr({ autoOpen: true });
    const events: OffscreenEvent[] = [];
    const metrics: MetricSample[] = [];

    const pipeline = createVoicePipeline({
      asrFactory: () => asr.asr,
      emit: (event) => events.push(event),
      vad: neverSpeech(),
      metricSink: (sample) => metrics.push(sample),
      now: () => 0,
    });

    pipeline.start();
    pipeline.pushFrame(speechFrame());
    asr.firePartial('spurious'); // a provider partial with no speech behind it

    // The level meter still moves, but nothing is sent and no onset was ever set, so no metric.
    expect(asr.sent).toHaveLength(0);
    expect(metrics).toHaveLength(0);
    expect(events.some((e) => e.kind === 'level')).toBe(true);
  });
});

describe('voice pipeline — reconnect and buffering', () => {
  it('buffers speech while the socket is not live and flushes it in order on open', () => {
    const { factory, instances } = createFakeAsrFactory({ autoOpen: false });
    const pipeline = createVoicePipeline({
      asrFactory: factory,
      emit: () => undefined,
      vad: alwaysSpeech(),
      now: () => 0,
    });

    pipeline.start(); // connecting — the fake does not auto-open
    const [a, b] = [speechFrame(), speechFrame()];
    pipeline.pushFrame(a);
    pipeline.pushFrame(b);
    expect(instances[0]?.sent).toHaveLength(0); // buffered, not sent

    instances[0]?.fireOpen();
    expect(pipeline.phase).toBe('listening');
    expect(instances[0]?.sent).toEqual([a, b]); // flushed, in order
  });

  it('moves to the visible dropped state when the buffer overruns rather than losing audio silently', () => {
    const { factory } = createFakeAsrFactory({ autoOpen: false });
    const events: OffscreenEvent[] = [];
    const pipeline = createVoicePipeline({
      asrFactory: factory,
      emit: (event) => events.push(event),
      vad: alwaysSpeech(),
      frameMs: 20,
      bufferMaxMs: 40, // capacity of 2 frames
      now: () => 0,
    });

    pipeline.start(); // connecting; frames buffer
    pipeline.pushFrame(speechFrame());
    pipeline.pushFrame(speechFrame());
    expect(pipeline.phase).toBe('connecting');
    pipeline.pushFrame(speechFrame()); // third frame overruns the 2-frame bound

    expect(pipeline.phase).toBe('dropped');
    expect(events.some((e) => e.kind === 'phase' && e.phase === 'dropped')).toBe(true);
  });

  it('reconnects with a scheduled backoff after an unclean drop', () => {
    const { factory, instances } = createFakeAsrFactory({ autoOpen: true });
    const scheduled: { fn: () => void; ms: number }[] = [];
    const pipeline = createVoicePipeline({
      asrFactory: factory,
      emit: () => undefined,
      vad: alwaysSpeech(),
      now: () => 0,
      schedule: (fn, ms) => {
        scheduled.push({ fn, ms });
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: () => undefined,
      random: () => 0,
    });

    pipeline.start();
    expect(pipeline.phase).toBe('listening');

    instances[0]?.fireClose({ wasClean: false }); // provider dropped us mid-listen
    expect(pipeline.phase).toBe('reconnecting');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBeGreaterThan(0);

    scheduled[0]?.fn(); // the backoff elapses: a fresh connection is opened and auto-opens
    expect(instances).toHaveLength(2);
    expect(pipeline.phase).toBe('listening');
  });

  it('gives up with asr_failed once reconnect attempts are exhausted', () => {
    const { factory, instances } = createFakeAsrFactory({ autoOpen: false });
    const events: OffscreenEvent[] = [];
    const scheduled: (() => void)[] = [];
    const pipeline = createVoicePipeline({
      asrFactory: factory,
      emit: (event) => events.push(event),
      vad: alwaysSpeech(),
      now: () => 0,
      schedule: (fn) => {
        scheduled.push(fn);
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: () => undefined,
      random: () => 0,
      maxReconnectAttempts: 2,
    });

    pipeline.start();
    instances[0]?.fireClose({ wasClean: false }); // attempt 1
    scheduled[0]?.();
    instances[1]?.fireClose({ wasClean: false }); // attempt 2
    scheduled[1]?.();
    instances[2]?.fireClose({ wasClean: false }); // attempt 3 — over the limit

    expect(pipeline.phase).toBe('error');
    expect(events.some((e) => e.kind === 'error' && e.reason === 'asr_failed')).toBe(true);
  });
});
