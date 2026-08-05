import type { ElementFingerprint } from 'protocol';

/**
 * The shapes crossing the page boundary during a reconcile.
 *
 * In their own module for the same reason `seed/located.ts` is: `crawl/in-page/drift.ts` is
 * bundled into the document by esbuild and type-checked under a DOM tsconfig, while the code that
 * reads its results runs in Node. A type both need has to live somewhere neither owns, or one of
 * them ends up importing a module full of browser globals.
 */

/** One remembered element, as the page is asked to look for it. */
export interface DriftTarget {
  readonly elementKey: string;
  readonly fingerprint: ElementFingerprint;
}

export interface DriftMatchOptions {
  readonly targets: readonly DriftTarget[];
  /** Viewport the stored fingerprints were normalised against. */
  readonly viewport: { readonly width: number; readonly height: number };
  /** The attribute `collect` stamped, so a match can name an element the caller already has. */
  readonly markerAttribute: string;
  /**
   * Minimum integrity score for a live element to be *the same element* memory recorded.
   *
   * Deliberately the seed adapter's floor rather than the runtime resolver's. Resolution is
   * choosing between candidates a tester might have meant, where a near-tie must become a
   * question. This is asking whether a control still exists, where being too strict does real
   * harm: an element that scores 0.6 because its label was reworded is a *rename*, and refusing
   * the match would report it as a deletion plus an addition — and every alias pointing at it
   * would be dropped rather than migrated.
   */
  readonly threshold: number;
}

/** A remembered element found on the page, named by the marker the collector stamped. */
export interface MatchedElement {
  readonly elementKey: string;
  readonly marker: number;
  readonly score: number;
}

export interface DriftMatchResult {
  readonly matched: readonly MatchedElement[];
  /** Element keys nothing on the page scored highly enough to be. */
  readonly missing: readonly string[];
  /** Markers of live elements no remembered element claimed. */
  readonly unmatchedMarkers: readonly number[];
}
