import type { ElementKey, ElementRecord, MemorySnapshot } from 'protocol';

import { createCandidateBinder, type CandidateBinder } from '../resolver/index.js';

/**
 * Finding the live element behind a resolved `elementKey`.
 *
 * A `ResolutionResult` names an element by `elementId`/`elementKey`, both of which live in memory; a
 * live DOM node carries neither. Closing that gap is exactly what the resolver's
 * {@link CandidateBinder} already does (CLAUDE.md rule #4 — one fingerprint implementation), so the
 * locator reuses it rather than re-deriving element identity. Given the current screen's fingerprint
 * and its live candidate set, it binds each node to its record and returns the one whose key matches.
 *
 * The binder memoises its work by the candidate array's identity, so locating the target the
 * resolver just resolved — same array, same screen — is a cache hit, not a second fingerprint pass.
 */

export interface Locator {
  locate(
    stateFingerprint: string,
    candidates: readonly Element[],
    elementKey: ElementKey,
  ): Element | null;
  /**
   * The keys of the current scope, as `RuntimeState.visibleElementKeys` wants them.
   *
   * The same bind {@link locate} performs, read for its other half: which of memory's elements are
   * on screen right now. The seeding flow sends this to the composer as the state the utterance was
   * spoken in, so "I need one of these" is scoped to the screen the tester is looking at.
   *
   * Optional, like `ResolverLike.pending`, so a caller that only ever locates — a benchmark, an
   * older test — need not implement it. Without it the scope is simply empty, which is a truthful
   * answer rather than a wrong one.
   */
  keys?(stateFingerprint: string, candidates: readonly Element[]): readonly ElementKey[];
}

/** Group a snapshot's element records by the state fingerprint of the screen they belong to. */
function groupByState(snapshot: MemorySnapshot): Map<string, ElementRecord[]> {
  const stateByScreen = new Map<string, string>();
  for (const screen of snapshot.screens) stateByScreen.set(screen.id, screen.stateFingerprint);

  const byState = new Map<string, ElementRecord[]>();
  for (const element of snapshot.elements) {
    const state = stateByScreen.get(element.screenId);
    if (state === undefined) continue;
    const bucket = byState.get(state);
    if (bucket === undefined) byState.set(state, [element]);
    else bucket.push(element);
  }
  return byState;
}

export function createBinderLocator(snapshot: MemorySnapshot): Locator {
  const binder: CandidateBinder = createCandidateBinder({ recordsByState: groupByState(snapshot) });
  return {
    locate(stateFingerprint, candidates, elementKey): Element | null {
      const binding = binder.bind(stateFingerprint, candidates);
      for (const candidate of binding.candidates) {
        if (candidate.record.elementKey === elementKey) return candidate.element;
      }
      return null;
    },

    keys(stateFingerprint, candidates): readonly ElementKey[] {
      // The binder memoises by the candidate array's identity, so asking for the scope right after
      // a resolution on the same screen is a cache hit rather than a second fingerprint pass.
      return binder.bind(stateFingerprint, candidates).candidateKeys;
    },
  };
}
