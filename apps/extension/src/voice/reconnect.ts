/**
 * The two pieces the reconnect path is built from: a bounded audio buffer and a backoff schedule.
 *
 * Both are pure and injected into the pipeline's state machine (`pipeline.ts`), which keeps the
 * "what happens when the socket drops" logic testable with fake timers and without a socket.
 *
 * The requirement they serve, verbatim from the phase: *"Reconnect with exponential backoff.
 * Buffer audio during reconnect up to 3s, then drop with a visible HUD state — never silently lose
 * audio."* The buffer enforces the 3 s bound and reports the overflow; the schedule produces the
 * backoff.
 */

export interface RingBuffer {
  /**
   * Append one frame. Returns `true` if a frame had to be dropped to stay within the bound —
   * which the pipeline turns into the visible `dropped` state. Never silent: the boolean is the
   * signal, and dropping it on the floor would defeat the requirement.
   */
  push(frame: Int16Array): boolean;
  /** Take everything buffered, in order, and empty the buffer. */
  drain(): Int16Array[];
  /** Number of frames held. */
  readonly size: number;
  clear(): void;
}

/**
 * A fixed-capacity FIFO of audio frames.
 *
 * Capacity is expressed in *milliseconds of audio* and converted to a frame count, so the caller
 * writes the 3 s bound in the units the requirement states rather than in frames. When full, the
 * oldest frame is evicted before the newest is added — a drop-oldest policy, because in speech the
 * most recent audio is the part still worth trying to send once the socket returns.
 */
export function createRingBuffer(options: {
  readonly maxMs: number;
  readonly frameMs: number;
}): RingBuffer {
  const capacity = Math.max(1, Math.floor(options.maxMs / options.frameMs));
  let frames: Int16Array[] = [];

  return {
    push(frame: Int16Array): boolean {
      let dropped = false;
      if (frames.length >= capacity) {
        frames.shift();
        dropped = true;
      }
      frames.push(frame);
      return dropped;
    },
    drain(): Int16Array[] {
      const out = frames;
      frames = [];
      return out;
    },
    get size(): number {
      return frames.length;
    },
    clear(): void {
      frames = [];
    },
  };
}

export interface BackoffConfig {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly factor: number;
  /** Fraction of full jitter, in [0, 1]. 0 makes the schedule deterministic for tests. */
  readonly jitter: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 250,
  maxMs: 8_000,
  factor: 2,
  jitter: 0.2,
};

/**
 * Delay before reconnect attempt `attempt` (0-based), exponential and capped, with optional
 * jitter drawn from `random` (injected so a test can pin it). Jitter spreads reconnect storms when
 * a provider blips for every tester at once; a test passes `jitter: 0` for an exact schedule.
 */
export function backoffDelay(
  attempt: number,
  config: BackoffConfig = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const raw = config.baseMs * config.factor ** Math.max(0, attempt);
  const capped = Math.min(config.maxMs, raw);
  const jitter = capped * config.jitter * random();
  return Math.round(capped - config.jitter * capped + jitter);
}
