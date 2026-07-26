import type { Scheduler } from './mutations.js';
import type { RuntimeWindow } from './route-bridge.js';

/**
 * Test doubles for the three streams the engine cannot drive itself.
 *
 * None of this is a mock of our own code — every module under test is the real one. What is
 * faked here is the *platform*, and only where happy-dom cannot supply it:
 *
 * - **`IntersectionObserver`** exists in happy-dom but never fires, because there is no layout
 *   engine to intersect anything. Every test that needs a visible set has to say what it is.
 * - **`MutationObserver`** does work, and delivers on a microtask. Real delivery would mean an
 *   `await` before every assertion, and the failure mode when a test forgets one is a flake.
 * - **Timers** would make each debounce assertion cost a real 50 ms and depend on the runner's
 *   scheduling.
 *
 * Shared by the unit tests and the benchmark so the two measure the same code path.
 */

/** A `Scheduler` whose pending callbacks fire only when the test says so. */
export interface ManualScheduler extends Scheduler {
  /** Run every callback currently due, in scheduling order. */
  runPending(): void;
  readonly pendingCount: number;
}

export function createManualScheduler(): ManualScheduler {
  const pending = new Map<number, () => void>();
  let nextHandle = 1;

  return {
    setTimeout(callback: () => void): number {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, callback);
      return handle;
    },

    clearTimeout(handle: number): void {
      pending.delete(handle);
    },

    get pendingCount(): number {
      return pending.size;
    },

    runPending(): void {
      // Snapshot first: a callback that schedules another timer must not be run in this pass,
      // or a rearming window would loop forever.
      const due = [...pending.entries()];
      pending.clear();
      for (const [, callback] of due) callback();
    },
  };
}

/** A `MutationObserver` whose records are delivered when the test hands them over. */
export interface ManualMutationObserver {
  readonly observer: MutationObserver;
  /** Deliver records to the stream synchronously, as the platform would on its microtask. */
  deliver(records: readonly MutationRecord[]): void;
  /** Records queued by {@link queue} and not yet taken. Drained by `takeRecords`. */
  queue(records: readonly MutationRecord[]): void;
  readonly observing: readonly Node[];
}

export function createManualMutationObserver(callback: MutationCallback): ManualMutationObserver {
  const observing: Node[] = [];
  let queued: MutationRecord[] = [];
  let connected = true;

  // Structurally a `MutationObserver` — `observe`, `disconnect`, `takeRecords` — which is the
  // whole interface `mutations.ts` uses, so no assertion is needed to satisfy the type.
  const observer: MutationObserver = {
    observe(target: Node): void {
      observing.push(target);
    },
    disconnect(): void {
      connected = false;
      observing.length = 0;
      queued = [];
    },
    takeRecords(): MutationRecord[] {
      const taken = queued;
      queued = [];
      return taken;
    },
  };

  return {
    observer,
    observing,
    queue(records: readonly MutationRecord[]): void {
      queued.push(...records);
    },
    deliver(records: readonly MutationRecord[]): void {
      if (!connected) return;
      callback([...records], observer);
    },
  };
}

/** An `IntersectionObserver` the test drives directly. */
export interface ManualIntersectionObserver {
  readonly observer: IntersectionObserver;
  /** Report an intersection change for elements the observer is watching. */
  report(entries: readonly { element: Element; isIntersecting: boolean }[]): void;
  /** Mark every observed element as intersecting. The common "everything is on screen" case. */
  reportAllVisible(): void;
  readonly observed: ReadonlySet<Element>;
}

export function createManualIntersectionObserver(
  callback: IntersectionObserverCallback,
): ManualIntersectionObserver {
  const observed = new Set<Element>();

  const observer: IntersectionObserver = {
    observe(element: Element): void {
      observed.add(element);
    },
    unobserve(element: Element): void {
      observed.delete(element);
    },
    disconnect(): void {
      observed.clear();
    },
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    },
  } as unknown as IntersectionObserver;

  const report = (entries: readonly { element: Element; isIntersecting: boolean }[]): void => {
    const delivered = entries
      .filter((entry) => observed.has(entry.element))
      .map(
        (entry) =>
          ({
            target: entry.element,
            isIntersecting: entry.isIntersecting,
            intersectionRatio: entry.isIntersecting ? 1 : 0,
          }) as unknown as IntersectionObserverEntry,
      );

    if (delivered.length > 0) callback(delivered, observer);
  };

  return {
    observer,
    observed,
    report,
    reportAllVisible(): void {
      report([...observed].map((element) => ({ element, isIntersecting: true })));
    },
  };
}

/**
 * A minimal `MutationRecord`.
 *
 * Constructed rather than captured from a real observer because the engine reads exactly four
 * fields — `type`, `target`, `addedNodes`, `removedNodes`, `attributeName` — and a test that
 * builds them states plainly which change it is describing.
 */
export function mutationRecord(
  init: Pick<MutationRecord, 'type' | 'target'> &
    Partial<Pick<MutationRecord, 'attributeName'>> & {
      readonly addedNodes?: readonly Node[];
      readonly removedNodes?: readonly Node[];
    },
): MutationRecord {
  return {
    type: init.type,
    target: init.target,
    attributeName: init.attributeName ?? null,
    addedNodes: init.addedNodes ?? [],
    removedNodes: init.removedNodes ?? [],
  } as unknown as MutationRecord;
}

/**
 * Casts across the happy-dom / `lib.dom` boundary.
 *
 * happy-dom's classes are behaviourally the DOM but are declared independently, so TypeScript
 * sees `HTMLBodyElement` and `Node` as unrelated types. These four exist so a test can say which
 * boundary it is crossing once, instead of scattering `as unknown as X` through its assertions —
 * and so that a genuinely wrong type still fails, since each one is used at a specific position.
 */
export function asRuntimeWindow(window: unknown): RuntimeWindow {
  return window as RuntimeWindow;
}

export function asNode(value: unknown): Node {
  return value as Node;
}

export function asElement(value: unknown): Element {
  return value as Element;
}

export function asHtmlElement(value: unknown): HTMLElement {
  return value as HTMLElement;
}
