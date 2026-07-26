import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createManualIntersectionObserver, type ManualIntersectionObserver } from './testing.js';
import { createVisibilityTracker, type VisibilityTracker } from './visibility.js';

describe('createVisibilityTracker', () => {
  let intersection: ManualIntersectionObserver;
  let changes: Element[][];
  let tracker: VisibilityTracker;
  let a: Element;
  let b: Element;

  beforeEach(() => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    a = document.querySelector('#a') as Element;
    b = document.querySelector('#b') as Element;

    changes = [];
    tracker = createVisibilityTracker({
      onChange: (changed) => {
        changes.push([...changed]);
      },
      observerFactory: (callback) => {
        intersection = createManualIntersectionObserver(callback);
        return intersection.observer;
      },
    });
  });

  it('tracks what is intersecting and reports only what flipped', () => {
    tracker.observe(a);
    tracker.observe(b);

    intersection.report([
      { element: a, isIntersecting: true },
      { element: b, isIntersecting: true },
    ]);
    expect([...tracker.visible]).toEqual([a, b]);
    expect(changes).toEqual([[a, b]]);

    intersection.report([
      { element: a, isIntersecting: true },
      { element: b, isIntersecting: false },
    ]);

    // `a` was already visible, so it is not in the change set. The scoped index updates from
    // this list, and including unchanged elements would make every scroll an O(candidates) pass.
    expect(changes[1]).toEqual([b]);
    expect([...tracker.visible]).toEqual([a]);
  });

  it('does not call onChange when nothing flipped', () => {
    const onChange = vi.fn();
    const quiet = createVisibilityTracker({
      onChange,
      observerFactory: (callback) => {
        intersection = createManualIntersectionObserver(callback);
        return intersection.observer;
      },
    });

    quiet.observe(a);
    intersection.report([{ element: a, isIntersecting: false }]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('drops an element from the visible set when it is unobserved', () => {
    tracker.observe(a);
    intersection.report([{ element: a, isIntersecting: true }]);
    expect(tracker.visible.has(a)).toBe(true);

    tracker.unobserve(a);

    // A detached element never gets a final non-intersecting callback. Without this it would
    // linger in the visible set forever, and the index would keep offering the resolver a node
    // that is no longer in the document.
    expect(tracker.visible.has(a)).toBe(false);
    expect(intersection.observed.has(a)).toBe(false);
  });

  it('clears everything on dispose', () => {
    tracker.observe(a);
    intersection.report([{ element: a, isIntersecting: true }]);

    tracker.dispose();

    expect([...tracker.visible]).toEqual([]);
    expect([...intersection.observed]).toEqual([]);
  });
});
