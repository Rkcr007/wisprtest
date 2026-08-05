import { scoreCandidate, defaultRedactor } from 'fingerprint';

import type { DriftMatchOptions, DriftMatchResult, MatchedElement } from '../../drift/matched.js';

/**
 * Matching what memory remembers against what the page now shows.
 *
 * The half of a reconcile that has to happen inside the document, for the same reason
 * `seed.ts` does: identity comes from `scoreCandidate` in `packages/fingerprint`, and that
 * function needs a live element rather than a description of one. Extracting the DOM into Node and
 * comparing there would mean a second implementation of what "the same element" means — which is
 * exactly the drift CLAUDE.md rule #4 exists to prevent, and it would drift against the resolver
 * the tester's commands actually go through.
 *
 * ## Why matching cannot go by element key
 *
 * An element key is minted from a `data-testid` *or the accessible name*, under a component
 * segment derived from the landmark path (`crawl/element-key.ts`). So a button that was renamed
 * gets a different key, and one that moved into a different landmark gets a different key too.
 *
 * Those are precisely the two changes a diff is supposed to *classify*. Matching by key would
 * report every rename and every move as a removal plus an unrelated addition, and a reviewer would
 * be asked to approve deleting a control that is still there under a new name — while every alias
 * pointing at it silently failed to migrate.
 *
 * So the key is used only as a fast path for elements that did not change identity, and everything
 * else is matched by score, which is what `ElementMove.matchConfidence` and
 * `ElementRename.matchConfidence` are for.
 *
 * ## Greedy, claimed, and best-first
 *
 * Each stored element takes the highest-scoring unclaimed candidate above the floor. The same
 * shape as `locateControls`, and it matters most on the case that motivates it: a table of twenty
 * identical row buttons, where every stored row scores well against every live row. Claiming makes
 * the assignment one-to-one instead of collapsing all twenty onto whichever scored highest.
 */

/** Elements the collector already stamped, in the order it stamped them. */
function markedElements(markerAttribute: string): Map<number, Element> {
  const found = new Map<number, Element>();
  for (const element of document.querySelectorAll(`[${markerAttribute}]`)) {
    const raw = element.getAttribute(markerAttribute);
    if (raw === null) continue;
    const marker = Number(raw);
    if (Number.isInteger(marker)) found.set(marker, element);
  }
  return found;
}

/**
 * Score every remembered element against the page, one-to-one.
 *
 * Runs after `collect`, and deliberately reuses the markers it stamped rather than re-walking the
 * DOM: the observed fingerprints are already computed and keyed by marker, so a match only has to
 * name one. Recomputing them here would cost a second layout pass over the whole page and, worse,
 * could produce a fingerprint subtly different from the one being reported as the observation.
 */
export function matchStored(options: DriftMatchOptions): DriftMatchResult {
  const byMarker = markedElements(options.markerAttribute);

  const measure = (element: Element): { x: number; y: number; width: number; height: number } => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  };

  const claimed = new Set<number>();
  const matched: MatchedElement[] = [];
  const missing: string[] = [];

  for (const target of options.targets) {
    let bestMarker: number | null = null;
    let bestScore = 0;

    for (const [marker, element] of byMarker) {
      if (claimed.has(marker)) continue;
      const score = scoreCandidate(target.fingerprint, element, {
        viewport: options.viewport,
        measure,
        redact: defaultRedactor,
      });
      if (score > bestScore) {
        bestMarker = marker;
        bestScore = score;
      }
    }

    if (bestMarker === null || bestScore < options.threshold) {
      missing.push(target.elementKey);
      continue;
    }

    claimed.add(bestMarker);
    matched.push({ elementKey: target.elementKey, marker: bestMarker, score: bestScore });
  }

  // Everything the page has that memory did not account for. Reported by marker so the caller
  // reads the fingerprint the collector already computed for it.
  const unmatchedMarkers: number[] = [];
  for (const marker of byMarker.keys()) {
    if (!claimed.has(marker)) unmatchedMarkers.push(marker);
  }

  return { matched, missing, unmatchedMarkers };
}
