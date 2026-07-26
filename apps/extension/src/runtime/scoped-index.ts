import {
  interactiveCandidates,
  isDisabled,
  isInert,
  isInteractiveCandidate,
  isSemanticallyHidden,
} from 'fingerprint';

import type { VisibilityTracker } from './visibility.js';

/**
 * The scoped element index — the candidate set the resolver is allowed to search.
 *
 * CLAUDE.md § "Resolution tiers" is blunt about why this exists: "Scoping is what makes T0/T1
 * fast *and* accurate: the runtime state engine narrows candidates from thousands of DOM nodes to
 * the dozens currently visible and reachable. Never resolve against the full document." Accuracy
 * is the half that is easy to miss — a smaller candidate set is not merely quicker to search, it
 * contains fewer things the tester could not possibly have meant, so the scores that come out of
 * it separate instead of clustering.
 *
 * ## Visible AND reachable
 *
 * Two different questions, answered from two different sources.
 *
 * **Visible** comes from `IntersectionObserver`, via {@link VisibilityTracker}. On screen, any
 * part of it. This subsumes every CSS way of hiding something.
 *
 * **Reachable** is semantic, and is three things:
 *
 * - not `hidden` or `aria-hidden`, on itself or an ancestor — the author has said it is not there;
 * - not `inert`, and not disabled — present, but nothing a tester can do to it;
 * - inside the topmost open dialog, when one is open. This is the part that only a *runtime*
 *   index can know. A modal makes the whole application behind it unreachable while leaving it
 *   perfectly visible, and an index that ignored this would happily resolve "approve" to the
 *   button underneath the confirmation asking whether to approve.
 *
 * ## Incremental, per docs/BUILD-PLAN.md Phase 7
 *
 * Nothing here is ever rebuilt from scratch after the initial walk. The work each event costs is
 * proportional to what actually changed:
 *
 * | Event | Work |
 * |---|---|
 * | Subtree added | walk the added subtree |
 * | Subtree removed | walk the removed subtree, which is detached and usually small |
 * | Attribute changed | the element, plus its registered descendants only if the attribute is one that inherits |
 * | Visibility changed | nothing — the tracker owns the set, this index only marks itself dirty |
 * | Modal opened or closed | one pass over registered candidates, which is rare and bounded |
 *
 * The derived list is computed lazily on {@link ScopedElementIndex.candidates} and memoised until
 * the next change, so a burst that touches a hundred nodes costs one derivation, not a hundred.
 *
 * The budget this is written against is 8 ms after a mutation burst on a 3000-node page, asserted
 * by `scoped-index.bench.ts` and wired to `pnpm --filter extension bench:scope`.
 */

/** Attributes whose effect reaches an element's descendants, not just the element itself. */
const INHERITED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'aria-hidden',
  'disabled',
  'hidden',
  'inert',
]);

interface Entry {
  /**
   * Whether the element is reachable on its own terms — not hidden, inert or disabled.
   *
   * Cached because it costs three ancestor walks and changes only when an attribute in
   * {@link INHERITED_ATTRIBUTES} moves somewhere above it.
   */
  selfReachable: boolean;

  /** Whether the element is inside the current scope root. Recomputed only when that changes. */
  inScope: boolean;
}

export interface ScopedElementIndex {
  /**
   * The candidate set: every registered element that is visible and reachable.
   *
   * Memoised. Repeated calls between changes return the same array, which is what makes it safe
   * for the speculation controller to ask on every partial ASR hypothesis.
   */
  candidates(): readonly Element[];

  /** Every element the index is tracking, whether or not it is currently a candidate. */
  readonly size: number;

  /** Whether this element is registered. Registration is not the same as being a candidate. */
  has(element: Element): boolean;

  /** Apply one coalesced mutation burst. */
  applyMutations(records: readonly MutationRecord[]): void;

  /** Note that the visible set has moved. The tracker owns the set; this only invalidates. */
  invalidateVisibility(): void;

  /**
   * Narrow reachability to a subtree — the topmost open dialog, or null for the whole document.
   *
   * A no-op when the root is unchanged, so the state engine can call it on every burst.
   */
  setScopeRoot(root: Element | null): void;

  dispose(): void;
}

export interface ScopedElementIndexOptions {
  /** The document subtree to index. The content script passes `document.body`. */
  readonly root: Element;

  /** Where visibility comes from. The index observes and unobserves through it as it registers. */
  readonly visibility: VisibilityTracker;
}

export function createScopedElementIndex(options: ScopedElementIndexOptions): ScopedElementIndex {
  const { root, visibility } = options;

  const entries = new Map<Element, Entry>();
  let scopeRoot: Element | null = null;
  let derived: readonly Element[] | null = null;

  function selfReachable(element: Element): boolean {
    return !isSemanticallyHidden(element) && !isInert(element) && !isDisabled(element);
  }

  function inScope(element: Element): boolean {
    return scopeRoot === null || scopeRoot.contains(element);
  }

  function register(element: Element): void {
    const existing = entries.get(element);
    if (existing !== undefined) {
      // Already tracked — an attribute change, or a subtree re-added under a new parent. Refresh
      // rather than re-observe: `IntersectionObserver.observe` on an already-observed element is
      // harmless but re-delivers an entry, and the scope may have changed under it.
      existing.selfReachable = selfReachable(element);
      existing.inScope = inScope(element);
      derived = null;
      return;
    }

    entries.set(element, { selfReachable: selfReachable(element), inScope: inScope(element) });
    visibility.observe(element);
    derived = null;
  }

  function unregister(element: Element): void {
    if (!entries.delete(element)) return;
    visibility.unobserve(element);
    derived = null;
  }

  /** Register `element` and every interactive descendant. */
  function registerTree(element: Element): void {
    if (isInteractiveCandidate(element)) register(element);
    for (const descendant of interactiveCandidates(element)) {
      register(descendant);
    }
  }

  /**
   * Unregister `element` and every registered descendant.
   *
   * Deliberately does not ask whether a node is interactive — a `Map.has` is far cheaper than
   * recomputing a role, and on a removal the answer would be the same anyway. It also means a
   * subtree whose roles changed while it was detached is still fully cleaned up.
   */
  function unregisterTree(element: Element): void {
    unregister(element);
    if (entries.size === 0) return;
    for (const descendant of element.querySelectorAll('*')) {
      unregister(descendant);
    }
  }

  function refreshAttribute(target: Element, attributeName: string | null): void {
    // Candidacy itself can turn on and off: a `role` or `tabindex` can make an ordinary div
    // operable, or stop it being so.
    if (isInteractiveCandidate(target)) register(target);
    else unregister(target);

    if (attributeName === null || !INHERITED_ATTRIBUTES.has(attributeName)) return;

    // `hidden` on a panel makes every control inside it unreachable. Only walked for the four
    // attributes that actually inherit — the other watched attributes affect one element, and
    // walking on those would make a busy form's every keystroke a subtree traversal.
    for (const descendant of target.querySelectorAll('*')) {
      const entry = entries.get(descendant);
      if (entry === undefined) continue;
      entry.selfReachable = selfReachable(descendant);
      derived = null;
    }
  }

  // The one full walk. Everything after this is incremental.
  registerTree(root);

  return {
    get size(): number {
      return entries.size;
    },

    has(element: Element): boolean {
      return entries.has(element);
    },

    candidates(): readonly Element[] {
      if (derived !== null) return derived;

      const visible = visibility.visible;
      const result: Element[] = [];
      for (const [element, entry] of entries) {
        if (entry.selfReachable && entry.inScope && visible.has(element)) result.push(element);
      }

      derived = result;
      return result;
    },

    applyMutations(records: readonly MutationRecord[]): void {
      // In record order, not deduplicated into sets. A node that was moved appears as a removal
      // and an addition, and only the order tells them apart; collapsing them would leave the
      // index holding whichever the set iterated last.
      for (const record of records) {
        if (record.type === 'childList') {
          for (const node of record.removedNodes) {
            if (node.nodeType === 1) unregisterTree(node as Element);
          }
          for (const node of record.addedNodes) {
            if (node.nodeType === 1) registerTree(node as Element);
          }
          continue;
        }

        if (record.type === 'attributes' && record.target.nodeType === 1) {
          refreshAttribute(record.target as Element, record.attributeName);
        }
      }
    },

    invalidateVisibility(): void {
      derived = null;
    },

    setScopeRoot(next: Element | null): void {
      if (next === scopeRoot) return;
      scopeRoot = next;

      for (const [element, entry] of entries) {
        entry.inScope = inScope(element);
      }
      derived = null;
    },

    dispose(): void {
      for (const element of entries.keys()) {
        visibility.unobserve(element);
      }
      entries.clear();
      derived = null;
    },
  };
}
