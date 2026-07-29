import type { SessionStep } from 'protocol';

/**
 * The session step buffer — what stands between a tester's actions and the control plane.
 *
 * docs/BUILD-PLAN.md Phase 12: "Buffer SessionSteps locally and flush in batches every 5s and on
 * detach" and "survive a service worker restart mid-session without losing buffered steps." Both
 * requirements point the same way: the buffer is *durable state*, not a variable.
 *
 * ## Why a service worker changes the problem
 *
 * Chrome terminates an idle MV3 service worker after roughly thirty seconds and restarts it on the
 * next event. Every module-level variable goes with it. A buffer that lived only in memory would
 * silently lose the last few actions of every session where the tester paused to read something —
 * which is exactly when the interesting steps happen. So each mutation is written through to
 * storage, and a worker that has just started rehydrates whatever the previous one left behind.
 *
 * ## At-least-once, over an idempotent endpoint
 *
 * Steps are removed from the buffer only after the gateway confirms them, so a flush that fails
 * mid-request is retried rather than lost. That means the same step can be delivered twice, which
 * is safe precisely because ingest is idempotent on `(sessionId, ordinal)` — the two halves of
 * this design only work together, and neither is optional.
 *
 * A batch the gateway *refuses* — a closed session, a validation failure — is discarded rather
 * than retried forever. Those cannot succeed later, and a queue that will not drain is a queue
 * that eventually loses everything behind it.
 */

/** Persistence for the buffer. Backed by `chrome.storage.session` in the worker. */
export interface BufferStore {
  read(sessionId: string): Promise<readonly SessionStep[]>;
  write(sessionId: string, steps: readonly SessionStep[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

/** Delivers one batch. Rejects on failure; the buffer decides whether to keep the steps. */
export type StepSender = (sessionId: string, steps: readonly SessionStep[]) => Promise<unknown>;

export interface SessionBufferOptions {
  readonly sessionId: string;
  readonly send: StepSender;
  readonly store: BufferStore;
  /** Flush cadence. 5s per the phase. */
  readonly intervalMs?: number;
  /** Largest batch in one request; a longer buffer goes out across several flushes. */
  readonly maxBatch?: number;
  /**
   * Hard cap on held steps.
   *
   * Generous, because losing a tester's history is worse than holding it: a session is minutes
   * long and a step is small. It exists so an hours-long outage cannot grow the buffer without
   * limit in a worker Chrome may terminate at any moment.
   */
  readonly maxPending?: number;
  readonly scheduleInterval?: (fn: () => void, ms: number) => () => void;
  readonly onError?: (error: unknown) => void;
}

export interface SessionBuffer {
  /** Hold a step for the next flush. Never throws — a recording failure must not fail an action. */
  add(step: SessionStep): void;
  /** Send what is held, oldest first. Resolves when the buffer is empty or a send failed. */
  flush(): Promise<void>;
  /** Steps currently held. */
  readonly size: number;
  /** Stop the timer and flush a final time — the detach path. */
  close(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BATCH = 50;
const DEFAULT_MAX_PENDING = 2_000;

function defaultScheduleInterval(fn: () => void, ms: number): () => void {
  const handle = setInterval(fn, ms);
  return () => {
    clearInterval(handle);
  };
}

/**
 * Whether a failed send is worth another attempt.
 *
 * A sender may say so explicitly with a `retryable` flag — the session client does, distinguishing
 * a 5xx from a closed session. Anything unrecognised is assumed transient: dropping a tester's
 * history because of an error we did not anticipate is the worse failure.
 */
function isRetryable(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'retryable' in error) {
    return (error as { retryable?: unknown }).retryable !== false;
  }
  return true;
}

/**
 * Create a buffer, rehydrating anything a previous worker left for this session.
 *
 * Async because the rehydrate is: a buffer that started empty and *then* loaded would race the
 * first `add`, and the step that arrived in between would be dropped by the write that follows.
 */
export async function createSessionBuffer(options: SessionBufferOptions): Promise<SessionBuffer> {
  const {
    sessionId,
    send,
    store,
    intervalMs = DEFAULT_INTERVAL_MS,
    maxBatch = DEFAULT_MAX_BATCH,
    maxPending = DEFAULT_MAX_PENDING,
    scheduleInterval = defaultScheduleInterval,
    onError,
  } = options;

  // Whatever the previous worker held. Ordinals are assigned by the content script and monotonic
  // within a session, so restored steps simply continue the sequence.
  let pending: SessionStep[] = [...(await store.read(sessionId))];
  let flushing: Promise<void> | null = null;
  let closed = false;

  const cancelTimer = scheduleInterval(() => {
    void flush();
  }, intervalMs);

  function persist(): void {
    // Fire and forget: the in-memory copy is authoritative for this worker, and storage is the
    // copy the *next* one reads. A failed write is reported, not awaited on the hot path.
    void store.write(sessionId, pending).catch((error: unknown) => {
      onError?.(error);
    });
  }

  async function drain(): Promise<void> {
    while (pending.length > 0) {
      const batch = pending.slice(0, maxBatch);

      try {
        await send(sessionId, batch);
      } catch (error: unknown) {
        onError?.(error);
        // Kept for the next tick when another attempt could work; discarded when it could not.
        // A closed session is the common case here — the tab went away mid-flush.
        if (!isRetryable(error)) {
          pending = pending.slice(batch.length);
          persist();
        }
        return;
      }

      // Removed only after the gateway confirmed them. A crash between the send and here means
      // the batch goes again, which is what makes ingest's idempotency load-bearing rather than
      // decorative.
      pending = pending.slice(batch.length);
      persist();
    }
  }

  function flush(): Promise<void> {
    // One flush at a time: two concurrent drains would send the same steps twice and could remove
    // a batch the other was about to retry.
    flushing ??= drain().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  return {
    add(step): void {
      if (closed) return;
      pending.push(step);
      if (pending.length > maxPending) {
        // Oldest first: a step from twenty minutes ago has already had many chances to flush.
        pending = pending.slice(pending.length - maxPending);
      }
      persist();
    },

    flush,

    get size(): number {
      return pending.length;
    },

    async close(): Promise<void> {
      closed = true;
      cancelTimer();
      await flush();
      // Only when the buffer actually drained: leaving steps in storage is what lets a later
      // worker pick them up, and clearing regardless would throw away the thing that survived.
      if (pending.length === 0) await store.clear(sessionId);
    },
  };
}
