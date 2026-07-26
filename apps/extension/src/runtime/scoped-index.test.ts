import { beforeEach, describe, expect, it } from 'vitest';

import { createScopedElementIndex, type ScopedElementIndex } from './scoped-index.js';
import {
  createManualIntersectionObserver,
  mutationRecord,
  type ManualIntersectionObserver,
} from './testing.js';
import { createVisibilityTracker, type VisibilityTracker } from './visibility.js';

/**
 * The scoped index is where "visible AND reachable" is decided, and where the incrementality
 * requirement lives. These tests assert both: what ends up in the candidate set, and that the
 * set is maintained rather than rebuilt.
 */
describe('createScopedElementIndex', () => {
  let intersection: ManualIntersectionObserver;
  let visibility: VisibilityTracker;
  let index: ScopedElementIndex;

  function build(html: string): void {
    document.body.innerHTML = html;
    visibility = createVisibilityTracker({
      onChange: () => {
        index.invalidateVisibility();
      },
      observerFactory: (callback) => {
        intersection = createManualIntersectionObserver(callback);
        return intersection.observer;
      },
    });
    index = createScopedElementIndex({ root: document.body, visibility });
    intersection.reportAllVisible();
  }

  function el(selector: string): Element {
    const found = document.querySelector(selector);
    if (found === null) throw new Error(`no element matched ${selector}`);
    return found;
  }

  function candidateIds(): string[] {
    return index
      .candidates()
      .map((element) => element.id)
      .sort();
  }

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('what counts as a candidate', () => {
    it('registers interactive elements by computed role, not by tag', () => {
      build(`
        <button id="approve">Approve</button>
        <div id="fake" role="button">Also a button</div>
        <a id="orders" href="/orders">Orders</a>
        <input id="query" />
        <p id="prose">Not interactive</p>
        <div id="wrapper">Not interactive</div>
      `);

      expect(candidateIds()).toEqual(['approve', 'fake', 'orders', 'query']);
    });

    it('registers what the author made operable without a role', () => {
      build(`
        <summary id="disclosure">More</summary>
        <div id="tabbable" tabindex="0">Focusable</div>
        <div id="editable" contenteditable="">Type here</div>
        <div id="untabbable" tabindex="-1">Programmatic focus only</div>
      `);

      expect(candidateIds()).toEqual(['disclosure', 'editable', 'tabbable']);
    });
  });

  describe('reachability', () => {
    it('excludes hidden, aria-hidden, inert and disabled subtrees', () => {
      build(`
        <button id="visible">Visible</button>
        <button id="disabled" disabled>Disabled</button>
        <button id="aria-disabled" aria-disabled="true">Disabled by ARIA</button>
        <div hidden><button id="in-hidden">Hidden</button></div>
        <div aria-hidden="true"><button id="in-aria-hidden">Hidden</button></div>
        <div inert><button id="in-inert">Inert</button></div>
      `);

      expect(candidateIds()).toEqual(['visible']);
      // Registered, just not candidates. They come back the moment the attribute goes away, and
      // rediscovering them would mean the full walk this index exists to avoid.
      expect(index.size).toBe(6);
    });

    it('excludes what is not intersecting the viewport', () => {
      build('<button id="above">Above</button><button id="below">Below the fold</button>');
      expect(candidateIds()).toEqual(['above', 'below']);

      intersection.report([{ element: el('#below'), isIntersecting: false }]);
      expect(candidateIds()).toEqual(['above']);

      intersection.report([{ element: el('#below'), isIntersecting: true }]);
      expect(candidateIds()).toEqual(['above', 'below']);
    });
  });

  describe('modal scope', () => {
    it('narrows reachability to the open dialog, and restores it on close', () => {
      build(`
        <main><button id="approve">Approve</button></main>
        <div id="confirm" role="dialog" aria-modal="true" aria-label="Confirm approval">
          <button id="yes">Yes</button>
          <button id="no">No</button>
        </div>
      `);

      // Everything is visible and nothing is hidden — this narrowing is the part only a runtime
      // index can know, and it is the difference between resolving "approve" to the button in
      // the confirmation and to the one underneath it.
      expect(candidateIds()).toEqual(['approve', 'no', 'yes']);

      index.setScopeRoot(el('#confirm'));
      expect(candidateIds()).toEqual(['no', 'yes']);

      index.setScopeRoot(null);
      expect(candidateIds()).toEqual(['approve', 'no', 'yes']);
    });

    it('scopes an element added while the dialog is open', () => {
      build(`
        <main><button id="approve">Approve</button></main>
        <div id="confirm" role="dialog"><button id="yes">Yes</button></div>
      `);
      index.setScopeRoot(el('#confirm'));

      const late = document.createElement('button');
      late.id = 'late';
      el('#confirm').append(late);
      index.applyMutations([
        mutationRecord({ type: 'childList', target: el('#confirm'), addedNodes: [late] }),
      ]);
      intersection.reportAllVisible();

      expect(candidateIds()).toEqual(['late', 'yes']);
    });
  });

  describe('incremental maintenance', () => {
    it('registers an added subtree without rewalking the document', () => {
      build('<main id="list"><button id="one">One</button></main>');

      const row = document.createElement('tr');
      row.innerHTML = '<td><button id="two">Two</button><a id="link" href="/x">X</a></td>';
      el('#list').append(row);

      index.applyMutations([
        mutationRecord({ type: 'childList', target: el('#list'), addedNodes: [row] }),
      ]);
      intersection.reportAllVisible();

      expect(candidateIds()).toEqual(['link', 'one', 'two']);
      expect(index.size).toBe(3);
    });

    it('registers an added element that is itself a candidate', () => {
      build('<main id="list"></main>');
      const button = document.createElement('button');
      button.id = 'solo';
      el('#list').append(button);

      // `querySelectorAll` skips the root it is called on, so an added leaf would be missed by
      // a descendant walk alone.
      index.applyMutations([
        mutationRecord({ type: 'childList', target: el('#list'), addedNodes: [button] }),
      ]);
      intersection.reportAllVisible();

      expect(candidateIds()).toEqual(['solo']);
    });

    it('unregisters a removed subtree and stops observing it', () => {
      build(`
        <main id="list">
          <div id="row"><button id="one">One</button></div>
          <button id="keep">Keep</button>
        </main>
      `);
      const row = el('#row');
      const one = el('#one');
      row.remove();

      index.applyMutations([
        mutationRecord({ type: 'childList', target: el('#list'), removedNodes: [row] }),
      ]);

      expect(candidateIds()).toEqual(['keep']);
      expect(index.has(one)).toBe(false);
      expect(visibility.visible.has(one)).toBe(false);
      expect(intersection.observed.has(one)).toBe(false);
    });

    it('handles a move, which arrives as a removal and an addition in one burst', () => {
      build(`
        <main id="from"><div id="row"><button id="one">One</button></div></main>
        <aside id="to"></aside>
      `);
      const row = el('#row');
      el('#to').append(row);

      // Order is the only thing distinguishing a move from a delete. Deduplicating records into
      // sets would leave the index holding whichever the set happened to iterate last.
      index.applyMutations([
        mutationRecord({ type: 'childList', target: el('#from'), removedNodes: [row] }),
        mutationRecord({ type: 'childList', target: el('#to'), addedNodes: [row] }),
      ]);
      intersection.reportAllVisible();

      expect(candidateIds()).toEqual(['one']);
    });

    it('re-evaluates descendants when an inherited attribute changes', () => {
      build(`
        <div id="panel"><button id="filter">Filter</button></div>
        <button id="other">Other</button>
      `);
      expect(candidateIds()).toEqual(['filter', 'other']);

      el('#panel').setAttribute('hidden', '');
      index.applyMutations([
        mutationRecord({ type: 'attributes', target: el('#panel'), attributeName: 'hidden' }),
      ]);
      expect(candidateIds()).toEqual(['other']);

      el('#panel').removeAttribute('hidden');
      index.applyMutations([
        mutationRecord({ type: 'attributes', target: el('#panel'), attributeName: 'hidden' }),
      ]);
      expect(candidateIds()).toEqual(['filter', 'other']);
    });

    it('tracks candidacy turning on and off through role', () => {
      build('<div id="maybe">Maybe</div>');
      expect(candidateIds()).toEqual([]);
      expect(index.has(el('#maybe'))).toBe(false);

      el('#maybe').setAttribute('role', 'button');
      index.applyMutations([
        mutationRecord({ type: 'attributes', target: el('#maybe'), attributeName: 'role' }),
      ]);
      intersection.reportAllVisible();
      expect(candidateIds()).toEqual(['maybe']);

      el('#maybe').removeAttribute('role');
      index.applyMutations([
        mutationRecord({ type: 'attributes', target: el('#maybe'), attributeName: 'role' }),
      ]);
      expect(candidateIds()).toEqual([]);
      expect(index.has(el('#maybe'))).toBe(false);
    });

    it('does not walk descendants for an attribute that affects only its element', () => {
      build('<div id="panel"><button id="filter">Filter</button></div>');

      // `role` on the panel cannot change whether the button inside it is reachable, so the
      // descendant walk is skipped. Asserted through the observable consequence: a descendant
      // whose reachability was changed behind the index's back stays stale until something that
      // does inherit touches it.
      el('#filter').setAttribute('disabled', '');
      index.applyMutations([
        mutationRecord({ type: 'attributes', target: el('#panel'), attributeName: 'role' }),
      ]);
      expect(candidateIds()).toEqual(['filter']);

      index.applyMutations([
        mutationRecord({ type: 'attributes', target: el('#filter'), attributeName: 'disabled' }),
      ]);
      expect(candidateIds()).toEqual([]);
    });

    it('memoises the derived list until something changes', () => {
      build('<button id="one">One</button>');

      const first = index.candidates();
      expect(index.candidates()).toBe(first);

      index.invalidateVisibility();
      expect(index.candidates()).not.toBe(first);
      expect(candidateIds()).toEqual(['one']);
    });
  });

  it('releases everything on dispose', () => {
    build('<button id="one">One</button><button id="two">Two</button>');
    index.dispose();

    expect(index.size).toBe(0);
    expect(index.candidates()).toEqual([]);
    expect([...intersection.observed]).toEqual([]);
  });
});
