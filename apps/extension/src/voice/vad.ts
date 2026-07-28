/**
 * Voice activity detection.
 *
 * The pipeline gates transmission on this: a frame that is not speech is not streamed to the ASR
 * provider, which keeps a tester's open-office background — keyboards, a colleague two desks over —
 * off the wire and out of the transcript, and keeps the provider bill proportional to speech.
 *
 * ## What this is, honestly
 *
 * This is an **adaptive energy + zero-crossing-rate** detector, not a port of libwebrtc's GMM VAD.
 * That was a deliberate choice (recorded in the phase's design notes): the GMM port is ~450 lines
 * of trained constant tables for a decision this product makes on 20 ms frames, and an adaptive
 * energy/ZCR gate with a hangover is both smaller and easy to reason about. The two signals cover
 * each other — energy catches voiced speech, zero-crossing rate catches the low-energy unvoiced
 * consonants (the /s/ and /f/ that an energy-only gate clips off the front of a word.
 *
 * It sits behind the {@link Vad} interface precisely so that decision is reversible: dropping in a
 * WASM WebRTC VAD, or a neural one, is a new `Vad` implementation and a config switch, with no
 * change to the pipeline that consumes it.
 *
 * ## Adaptation
 *
 * The noise floor is estimated continuously from frames judged to be non-speech, with a slow
 * upward and faster downward track, so a detector started in a noisy room settles to that room
 * rather than to a compiled-in constant. Speech is declared when a frame's energy exceeds the
 * floor by the aggressiveness-derived margin *and* its zero-crossing rate is in the speech band,
 * or when either signal alone is emphatic. A hangover keeps the gate open for a few frames past
 * the last speech frame so the natural pauses inside a phrase do not chop it into fragments.
 */

export interface Vad {
  /**
   * Judge one frame. Returns true when the frame should be treated as speech — which includes the
   * hangover window after real speech, so a caller streams a continuous utterance rather than its
   * voiced islands.
   */
  process(frame: Int16Array): boolean;
  /** The most recent activity level in [0, 1], for the meter. */
  readonly level: number;
  /** Forget the learned noise floor and hangover. Called when the microphone is (re)opened. */
  reset(): void;
}

export interface VadConfig {
  /**
   * 0 = permissive (gate opens easily, few clipped words, more noise through),
   * 3 = aggressive (gate stays shut unless it is clearly speech). Mirrors the 0–3 scale testers
   * know from the WebRTC VAD, so the setting transfers if the implementation is ever swapped.
   */
  readonly aggressiveness: 0 | 1 | 2 | 3;
  /** Frames to keep the gate open after the last speech frame. Bridges intra-phrase pauses. */
  readonly hangoverFrames: number;
  /** Frames of sustained activity before the gate opens. Rejects a single transient (a key click). */
  readonly onsetFrames: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  aggressiveness: 2,
  hangoverFrames: 8, // ~160 ms at 20 ms frames: covers the gap between words
  onsetFrames: 2, // ~40 ms: one stray sample cannot open the gate
};

/** How many dB over the noise floor a frame's energy must sit, per aggressiveness level. */
const MARGIN_DB: Record<VadConfig['aggressiveness'], number> = { 0: 3, 1: 6, 2: 9, 3: 12 };

// The zero-crossing rate band that voiced and most unvoiced speech falls in, as a fraction of the
// samples in a frame. Below it is a hum or a low rumble; far above it is hiss or white noise. The
// upper bound is generous because unvoiced fricatives are genuinely high-ZCR.
const ZCR_MIN = 0.05;
const ZCR_MAX = 0.5;

// Emphatic-energy shortcut: a frame this far over the floor is speech regardless of its ZCR, so a
// loud voiced vowel is never rejected for having too few zero crossings.
const EMPHATIC_DB = 18;

// Noise-floor tracking rates. Rising slowly means a burst of speech does not drag the floor up
// after itself; falling faster means moving into a quieter room is picked up within a breath.
const FLOOR_RISE = 0.03;
const FLOOR_FALL = 0.2;

function frameEnergyDb(frame: Int16Array): number {
  if (frame.length === 0) return -Infinity;
  let sumSquares = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const sample = frame[i] ?? 0;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / frame.length);
  // Referenced to full-scale Int16 (32768). Silence floors at a finite value rather than -Inf so
  // the adaptive floor arithmetic stays well-defined.
  return 20 * Math.log10(Math.max(rms, 1) / 32768);
}

function zeroCrossingRate(frame: Int16Array): number {
  if (frame.length < 2) return 0;
  let crossings = 0;
  let previous = frame[0] ?? 0;
  for (let i = 1; i < frame.length; i += 1) {
    const sample = frame[i] ?? 0;
    // A sign change with a small deadband, so dither around zero in near-silence is not counted as
    // a crossing and mistaken for high-ZCR fricative energy.
    if ((previous <= 0 && sample > 0) || (previous >= 0 && sample < 0)) {
      if (Math.abs(sample - previous) > 8) crossings += 1;
    }
    previous = sample;
  }
  return crossings / (frame.length - 1);
}

export function createVad(config: VadConfig = DEFAULT_VAD_CONFIG): Vad {
  const marginDb = MARGIN_DB[config.aggressiveness];

  // Seed the floor low; the first non-speech frames pull it up to the real room within ~1 s.
  let floorDb = -60;
  let hangover = 0;
  let onsetRun = 0;
  let level = 0;
  let primed = false;

  function judge(frame: Int16Array): boolean {
    const energyDb = frameEnergyDb(frame);
    const zcr = zeroCrossingRate(frame);

    const overFloor = energyDb - floorDb;
    // Level is how far over the floor we are, mapped into [0, 1] across a 30 dB span — what the
    // meter shows. Independent of the speech decision so the bars move with the room, not just
    // when the gate is open.
    level = Math.min(1, Math.max(0, overFloor / 30));

    const emphatic = overFloor >= EMPHATIC_DB;
    const energetic = overFloor >= marginDb;
    const speechBand = zcr >= ZCR_MIN && zcr <= ZCR_MAX;
    const isSpeechFrame = emphatic || (energetic && speechBand);

    if (isSpeechFrame) {
      onsetRun += 1;
    } else {
      onsetRun = 0;
      // Adapt the floor only on non-speech frames, so speech never trains the detector to ignore
      // itself. Track up slowly, down quickly.
      const rate = energyDb < floorDb ? FLOOR_FALL : FLOOR_RISE;
      floorDb = floorDb + rate * (energyDb - floorDb);
    }

    // The gate opens once activity has been sustained for `onsetFrames`, then latches open for the
    // hangover window past the last speech frame.
    if (onsetRun >= config.onsetFrames) {
      primed = true;
      hangover = config.hangoverFrames;
      return true;
    }
    if (primed && hangover > 0) {
      hangover -= 1;
      if (hangover === 0) primed = false;
      return true;
    }
    return false;
  }

  return {
    process: judge,
    get level(): number {
      return level;
    },
    reset(): void {
      floorDb = -60;
      hangover = 0;
      onsetRun = 0;
      level = 0;
      primed = false;
    },
  };
}
