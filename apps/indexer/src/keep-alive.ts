/**
 * Holds the event loop open while the worker has no work source attached.
 *
 * A registered signal handler does **not** keep Node alive on its own, so without a ref'd
 * handle the indexer would log its startup line and exit immediately — it could never receive
 * the SIGTERM it is supposed to shut down on.
 *
 * This is a handle, not a poll: the callback is empty and the interval is ~24 days, so it
 * never actually fires in a real process lifetime. Phase 5 replaces it outright — a Redis
 * stream consumer is itself a ref'd handle, and this module is deleted when it lands.
 */

/** Node clamps timers above 2^31-1 ms back to 1 ms, so this is the longest safe period. */
const MAX_TIMER_MS = 2_147_483_647;

export interface KeepAlive {
  /** Releases the handle, allowing the process to exit once nothing else is pending. */
  release: () => void;
  readonly isHeld: boolean;
}

export function holdEventLoop(): KeepAlive {
  let handle: NodeJS.Timeout | undefined = setInterval(() => {
    // Intentionally empty: the handle's existence is the entire effect.
  }, MAX_TIMER_MS);

  return {
    release: () => {
      if (handle !== undefined) {
        clearInterval(handle);
        handle = undefined;
      }
    },
    get isHeld(): boolean {
      return handle !== undefined;
    },
  };
}
