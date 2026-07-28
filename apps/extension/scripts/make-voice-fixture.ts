import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Generate the recorded voice fixture: `test/fixtures/voice/utterance-16k-mono.pcm`.
 *
 * A committed audio file is what the phase means by a "recorded audio fixture", and one on disk is
 * what the VAD and framer tests load. We cannot literally record a human here, so this synthesises
 * a **speech-shaped** signal deterministically — silence, then a voiced segment built from a glottal
 * fundamental and formant-like harmonics under a syllabic amplitude envelope with a little shaped
 * noise, then silence again. It is not real speech, but it has the two things the VAD gates on: a
 * quiet room to learn a floor from, and an energetic, mid-zero-crossing-rate body to open on.
 *
 * Deterministic (a seeded PRNG), so the byte output is stable and a test asserting frame counts or
 * speech boundaries does not drift between runs. Regenerate with:
 *   pnpm --filter extension exec tsx scripts/make-voice-fixture.ts
 */

const SAMPLE_RATE = 16_000;
const LEAD_SILENCE_S = 0.4;
const SPEECH_S = 1.2;
const TAIL_SILENCE_S = 0.4;

/** mulberry32 — a tiny seeded PRNG, so the fixture bytes are identical on every machine. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toInt16(sample: number): number {
  const clamped = Math.min(1, Math.max(-1, sample));
  return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
}

function build(): Int16Array {
  const rand = mulberry32(0x57495350); // "WISP"
  const lead = Math.round(LEAD_SILENCE_S * SAMPLE_RATE);
  const speech = Math.round(SPEECH_S * SAMPLE_RATE);
  const tail = Math.round(TAIL_SILENCE_S * SAMPLE_RATE);
  const total = lead + speech + tail;
  const out = new Int16Array(total);

  // A faint noise floor everywhere, so "silence" is a real quiet room the VAD adapts to rather than
  // digital zero it can never learn a floor from.
  for (let i = 0; i < total; i += 1) out[i] = toInt16((rand() - 0.5) * 0.003);

  const f0 = 120; // glottal fundamental, a low male-ish voice
  const formants = [
    { hz: 600, gain: 1.0 },
    { hz: 1200, gain: 0.6 },
    { hz: 2400, gain: 0.35 },
  ];

  for (let n = 0; n < speech; n += 1) {
    const t = n / SAMPLE_RATE;
    // Two syllables: an amplitude envelope that dips in the middle, so the VAD's hangover has a
    // real intra-utterance pause to bridge rather than one flat tone.
    const syllable = 0.5 + 0.5 * Math.cos(2 * Math.PI * 2.2 * t);
    const attack = Math.min(1, n / (0.02 * SAMPLE_RATE));
    const release = Math.min(1, (speech - n) / (0.04 * SAMPLE_RATE));
    const envelope = 0.55 * syllable * attack * release;

    let voiced = 0;
    for (const formant of formants) {
      voiced += formant.gain * Math.sin(2 * Math.PI * formant.hz * t);
    }
    voiced *= 0.4 + 0.6 * Math.abs(Math.sin(Math.PI * f0 * t)); // glottal pulse modulation
    const aspiration = (rand() - 0.5) * 0.25; // unvoiced energy, lifts the zero-crossing rate

    out[lead + n] = toInt16(envelope * (voiced * 0.3 + aspiration));
  }

  return out;
}

const outPath = fileURLToPath(
  new URL('../test/fixtures/voice/utterance-16k-mono.pcm', import.meta.url),
);
mkdirSync(fileURLToPath(new URL('../test/fixtures/voice/', import.meta.url)), { recursive: true });

const pcm = build();
writeFileSync(outPath, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));

process.stdout.write(
  `${JSON.stringify({
    event: 'voice.fixture_built',
    path: outPath,
    samples: pcm.length,
    duration_s: Math.round((pcm.length / SAMPLE_RATE) * 1000) / 1000,
  })}\n`,
);
