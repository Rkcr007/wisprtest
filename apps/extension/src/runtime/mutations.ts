/**
 * The mutation stream: a `MutationObserver` coalesced into bursts.
 *
 * ## Leading edge, then a 50 ms trailing window
 *
 * A trailing-only debounce would put 50 ms between the tester clicking a filter and the scoped
 * index knowing the table changed — a fifth of the entire speech-to-reticle budget, spent
 * waiting. So the *first* record after a quiet period dispatches synchronously, and everything
 * for the next 50 ms is coalesced into one more dispatch behind it.
 *
 * The common case is that a single interaction produces one burst of records: the leading edge
 * handles it immediately and the trailing dispatch finds nothing to do. A framework that
 * re-renders in several passes produces a second dispatch 50 ms later, and a continuously
 * animating page dispatches at most every 50 ms rather than on every frame.
 *
 * ## Settle
 *
 * When the window closes with nothing accumulated, the DOM has gone quiet. That is the signal
 * `state-engine.ts` recomputes the structural hash on — docs/ARCHITECTURE.md § 3 specifies it as
 * "computed on route settle", and it is a full-tree walk that has no business running per burst.
 *
 * ## Never `setInterval`
 *
 * The only timer here is the coalescing window, started by a mutation and not restarted when
 * nothing arrives. A quiet page schedules nothing at all.
 */

/** The default coalescing window, from docs/BUILD-PLAN.md Phase 7: "debounced 50ms". */
export const DEFAULT_DEBOUNCE_MS = 50;

/**
 * Attributes worth waking up for.
 *
 * A filtered list rather than all attributes, because `attributes: true` unfiltered on a busy
 * application is a record per animation frame per animating node.
 *
 * Notably absent are `class` and `style`. They are how CSS visibility changes, and CSS
 * visibility is the one thing the scoped index does *not* derive from the DOM: an element hidden
 * by a stylesheet stops intersecting, and `IntersectionObserver` reports that directly. Watching
 * them here would double the record volume on every hover state in the application to learn
 * something we are already told.
 *
 * Also absent are `aria-label` and friends. They change an element's accessible name, which
 * matters to resolution — but the resolver recomputes the live fingerprint at resolve time
 * (`packages/fingerprint`'s `resolve`), so the index does not cache a name that could go stale.
 */
export const WATCHED_ATTRIBUTES: readonly string[] = [
  // Reachability.
  'aria-disabled',
  'aria-hidden',
  'disabled',
  'hidden',
  'inert',
  // Modal stack.
  'aria-modal',
  'open',
  // Whether the element is a candidate at all.
  'contenteditable',
  'role',
  'tabindex',
  'type',
];

/** One coalesced group of mutation records. */
export interface MutationBurst {
  readonly records: readonly MutationRecord[];
  /** True when this is the first dispatch after a quiet period, delivered without waiting. */
  readonly leading: boolean;
}

/** The timer functions, injectable so tests drive the window rather than sleep through it. */
export interface Scheduler {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

/** The ambient timers, as a scheduler. Bound, because a bare `setTimeout` loses its receiver. */
export const globalScheduler: Scheduler = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle);
  },
};

export interface MutationStreamOptions {
  /** Called with every coalesced burst. */
  readonly onBurst: (burst: MutationBurst) => void;

  /**
   * Called when the window closes with nothing accumulated — the DOM has gone quiet.
   *
   * Fires once per quiet period, not repeatedly, because the timer is not rearmed until the next
   * mutation arrives.
   */
  readonly onSettle?: () => void;

  readonly debounceMs?: number;
  readonly scheduler?: Scheduler;

  /**
   * How the observer is constructed. Defaults to the platform's.
   *
   * Injectable for the same reason the scheduler is: a test that has to trigger a real
   * `MutationObserver` is a test that has to await a microtask checkpoint before every
   * assertion, and the failure mode when it forgets is a flake rather than an error.
   */
  readonly observerFactory?: (callback: MutationCallback) => MutationObserver;
}

export interface MutationStream {
  /** Start observing a subtree. Called once with the document element. */
  observe(root: Node): void;
  /**
   * Deliver anything the observer has queued but not yet reported, right now.
   *
   * `MutationObserver` delivers on a microtask, so a caller that has just mutated the DOM itself
   * — the action executor, in Phase 10 — would otherwise resolve against an index that is one
   * turn behind. This drains the queue synchronously.
   */
  flush(): void;
  dispose(): void;
}

export function createMutationStream(options: MutationStreamOptions): MutationStream {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const scheduler = options.scheduler ?? globalScheduler;
  const factory = options.observerFactory ?? ((callback) => new MutationObserver(callback));

  let pending: MutationRecord[] = [];
  let timer: number | null = null;
  let disposed = false;

  const drain = (leading: boolean): void => {
    const records = pending;
    pending = [];
    options.onBurst({ records, leading });
  };

  const onWindowClosed = (): void => {
    timer = null;
    if (disposed) return;

    if (pending.length === 0) {
      options.onSettle?.();
      return;
    }

    drain(false);
    // Rearmed, so a page mutating continuously dispatches on a fixed cadence instead of
    // alternating between a leading edge and a trailing one at twice the rate.
    timer = scheduler.setTimeout(onWindowClosed, debounceMs);
  };

  const accept = (records: readonly MutationRecord[]): void => {
    if (disposed || records.length === 0) return;

    pending.push(...records);

    if (timer === null) {
      drain(true);
      timer = scheduler.setTimeout(onWindowClosed, debounceMs);
    }
  };

  const observer = factory((records) => {
    accept(records);
  });

  return {
    observe(root: Node): void {
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [...WATCHED_ATTRIBUTES],
      });
    },

    flush(): void {
      accept(observer.takeRecords());
    },

    dispose(): void {
      disposed = true;
      if (timer !== null) {
        scheduler.clearTimeout(timer);
        timer = null;
      }
      pending = [];
      observer.disconnect();
    },
  };
}
