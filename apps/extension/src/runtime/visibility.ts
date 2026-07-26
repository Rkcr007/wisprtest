/**
 * The visible set, from `IntersectionObserver`.
 *
 * ## Why the platform observer and not a geometry check
 *
 * `getBoundingClientRect` on every candidate forces a layout pass, and doing it on every
 * mutation burst is the single easiest way to make a QA tool that visibly slows down the
 * application it is testing. `IntersectionObserver` computes intersections off the main thread
 * and reports only what changed.
 *
 * It also answers a question we would otherwise have to ask separately: an element hidden by
 * `display: none`, `visibility: hidden`, a zero-height clipping ancestor or a collapsed
 * accordion does not intersect. That is why `class` and `style` are absent from
 * `WATCHED_ATTRIBUTES` in `mutations.ts` — CSS visibility arrives here instead, without a single
 * `getComputedStyle` call on the hot path.
 *
 * ## Threshold 0, viewport root
 *
 * "Visible" for a tester means "on screen" — any part of it. A threshold above 0 would drop the
 * half-scrolled row they are pointing at, and a threshold list would multiply callbacks for no
 * gain, since nothing downstream reads the ratio.
 */

export interface VisibilityTrackerOptions {
  /**
   * Called after the visible set changes, with the elements whose state flipped.
   *
   * Only the changed elements, because the scoped index updates incrementally: handing it the
   * whole set would make every scroll an O(candidates) pass instead of an O(changed) one.
   */
  readonly onChange: (changed: readonly Element[]) => void;

  /**
   * How the observer is constructed. Defaults to the platform's.
   *
   * Injectable because happy-dom implements `IntersectionObserver` but has no layout engine, so
   * it never fires. Tests and the benchmark supply a fake and drive intersection directly, which
   * is also the only way to get a deterministic visible set.
   */
  readonly observerFactory?: (callback: IntersectionObserverCallback) => IntersectionObserver;
}

export interface VisibilityTracker {
  /** Elements currently intersecting the viewport. */
  readonly visible: ReadonlySet<Element>;
  observe(element: Element): void;
  unobserve(element: Element): void;
  dispose(): void;
}

export function createVisibilityTracker(options: VisibilityTrackerOptions): VisibilityTracker {
  const visible = new Set<Element>();

  const factory =
    options.observerFactory ??
    ((callback) => new IntersectionObserver(callback, { root: null, threshold: 0 }));

  const observer = factory((entries) => {
    const changed: Element[] = [];

    for (const entry of entries) {
      const was = visible.has(entry.target);
      if (entry.isIntersecting === was) continue;

      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
      changed.push(entry.target);
    }

    if (changed.length > 0) options.onChange(changed);
  });

  return {
    visible,

    observe(element: Element): void {
      observer.observe(element);
    },

    unobserve(element: Element): void {
      observer.unobserve(element);
      // Dropped from the set as well as from the observer. A detached element never gets a
      // final non-intersecting callback, so without this it would linger in the visible set
      // forever and the scoped index would keep offering the resolver a node that is gone.
      visible.delete(element);
    },

    dispose(): void {
      observer.disconnect();
      visible.clear();
    },
  };
}
