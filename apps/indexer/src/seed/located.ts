import type { ElementFingerprint } from 'protocol';

/**
 * The payload the in-page control locator returns, and the options it takes.
 *
 * DOM-free, for the same reason as `crawl/collected.ts`: this module is imported by the worker,
 * which has no DOM types, and by `crawl/in-page/seed.ts`, which has nothing else. Everything
 * crosses the CDP boundary through `structuredClone`, so it is plain data.
 */

/** One control the adapter needs to fill, and the memory record that says which one it is. */
export interface SeedTarget {
  /** The schema field this control edits. Carried through so a failure can name it. */
  readonly field: string;
  readonly elementKey: string;
  readonly fingerprint: ElementFingerprint;
}

/**
 * How a located control has to be driven.
 *
 * A DOM fact, read in the page and reported back, because Playwright needs to know whether to
 * type, pick or toggle — and the *schema* cannot say: a field learned as an `enum` is a
 * `<select>` on one application and a group of radios on the next. Reading it live also means an
 * application that changed a text input into a dropdown fails at the fill with a legible reason
 * instead of silently typing into something that ignores it.
 */
export type SeedControlKind = 'select' | 'checkbox' | 'radio' | 'file' | 'editable';

/** A control that was found, with the marker Playwright will address it by. */
export interface LocatedControl {
  readonly field: string;
  readonly elementKey: string;
  /** Value of the seed marker attribute stamped on the element. */
  readonly marker: number;
  readonly kind: SeedControlKind;
  /** Integrity score against the stored fingerprint, from `packages/fingerprint`. */
  readonly score: number;
  /** True when the control is disabled or read-only, and so cannot be filled at all. */
  readonly writable: boolean;
}

/** A control that was not found, with enough detail to say why in one sentence. */
export interface MissingControl {
  readonly field: string;
  readonly elementKey: string;
  /** Best score any live element reached. Zero when the page held no candidates at all. */
  readonly bestScore: number;
}

export interface SeedLocateOptions {
  readonly targets: readonly SeedTarget[];
  /** Viewport the stored fingerprints were normalised against. */
  readonly viewport: { readonly width: number; readonly height: number };
  readonly markerAttribute: string;
  /**
   * Minimum integrity score for a control to be considered the one memory recorded.
   *
   * Lower than the runtime resolution threshold on purpose. Resolution is choosing between
   * candidates a tester might have meant, where a near-tie has to become a question; this is
   * confirming that a control named by the schema is still on the page, where there is nothing
   * to choose between and refusing costs a materialization that would have worked.
   */
  readonly threshold: number;
}

export interface SeedLocateResult {
  readonly located: readonly LocatedControl[];
  readonly missing: readonly MissingControl[];
}

/** Where the submit control was found, or why it was not. */
export interface SubmitLocation {
  readonly marker: number | null;
  /** Populated exactly when `marker` is null. */
  readonly reason: string | null;
}

export interface RecordControlOptions {
  readonly target: SeedTarget;
  /** The record's own path. The row that links here is the row for this record. */
  readonly detailPath: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly markerAttribute: string;
  readonly marker: number;
  readonly threshold: number;
}

/** Where a record's own copy of a repeated control was found, or why it was not. */
export interface RecordControlLocation {
  readonly marker: number | null;
  /** How many live elements matched the fingerprint at all, before scoping to the record. */
  readonly matched: number;
  /** Populated exactly when `marker` is null. */
  readonly reason: string | null;
}
