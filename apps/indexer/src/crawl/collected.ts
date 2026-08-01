import type { ElementFingerprint } from 'protocol';

/**
 * The payload the in-page collector returns, and the options it takes.
 *
 * DOM-free on purpose: this module is imported by the worker (which has no DOM types) and by
 * `in-page/collect.ts` (which has nothing else). Everything here has to survive
 * `structuredClone` across the CDP boundary, so it is plain data — no handles, no functions.
 */

export interface CollectOptions {
  /** Route pattern for the current URL, computed on the worker side and passed in. */
  readonly routePattern: string;

  /**
   * Selectors the crawl must never interact with, from the application's bounds.
   *
   * Evaluated here rather than on the worker side because matching needs the live element:
   * an element is off-limits if it matches, *or if it is inside something that matches*, so a
   * Delete button nested in a `[data-destructive]` toolbar is protected too.
   */
  readonly neverInteractSelectors: readonly string[];

  /** Viewport to normalise fingerprint geometry against. Pinned so a fingerprint is reproducible. */
  readonly viewport: { readonly width: number; readonly height: number };

  /**
   * Attribute stamped on each collected element so Playwright can address it afterwards.
   *
   * The crawler needs to click a specific element it has already fingerprinted, and a CSS
   * selector reconstructed from the fingerprint would be exactly the fragile identity the whole
   * system exists to avoid. Stamping is invisible to the fingerprint: this name is in neither
   * `stableAttributeNames` nor `structuralAttributeNames`, so it changes no signal and no hash.
   */
  readonly markerAttribute: string;
}

/** One interactive element, as observed on one screen. */
export interface CollectedElement {
  /** Value of the marker attribute, unique within this collection pass. */
  readonly marker: number;
  readonly fingerprint: ElementFingerprint;

  /**
   * Whether the crawler may click this element while deriving nav edges.
   *
   * False for anything the never-interact list covers, anything that submits a form, and
   * anything disabled — see `in-page/collect.ts` for the full rule and the reasoning.
   */
  readonly interactable: boolean;

  /** Why it may not be interacted with. Null when it may. Reported, never silently dropped. */
  readonly blockedReason: 'never_interact' | 'form_submitter' | 'disabled' | 'hidden' | null;

  /** Absolute `href` for links, so the frontier and the SSRF policy can inspect it before a click. */
  readonly href: string | null;
}

/**
 * One control of one form, as the page declares it.
 *
 * Everything here is the *application's own statement about its data*: what the field is called,
 * what type it holds, whether it is mandatory, and what values it will accept. That is the shape
 * of an entity, and it is available without submitting anything — which matters, because the
 * crawl is forbidden from submitting.
 *
 * PII: `accessibleName` and every entry of `options` has been through the redactor. No `value`,
 * no `placeholder` and no `textContent` is collected at all — a control's *content* is the
 * tester's data, and the observers need only its shape.
 */
export interface CollectedControl {
  /** Marker of the collected element that edits this field, so it can be given an element key. */
  readonly marker: number | null;
  /** The `name` attribute. Structure, and the key the application's own API is likely to use. */
  readonly name: string;
  /** Redacted accessible name — the label a tester reads. */
  readonly accessibleName: string;
  /** `select`, `textarea`, or the input's `type`. Normalised to lowercase. */
  readonly controlType: string;
  readonly required: boolean;
  /** The `pattern` attribute's source, verbatim. Null when absent. */
  readonly pattern: string | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly minLength: number | null;
  readonly maxLength: number | null;
  /**
   * Redacted `<option>` values, capped. A closed set of choices is a vocabulary; a picker with
   * hundreds of entries is a reference to another collection, and is left for the network
   * observer to identify rather than recorded here as an enum.
   */
  readonly options: readonly string[];
  /** How many options there really were, before the cap. Distinguishes a vocabulary from a list. */
  readonly optionCount: number;
}

/** One form, or one form-like region, as observed on a route. */
export interface CollectedFormRegion {
  /** Redacted accessible name of the form — `Create order`. The component half of its id. */
  readonly accessibleName: string;
  /** Lowercased `method`, defaulting to `get` exactly as the HTML specification does. */
  readonly method: string;
  /** Absolute URL the form posts to. Empty when the region is not a `<form>`. */
  readonly action: string;
  readonly controls: readonly CollectedControl[];
}

/** Everything one settled route yields. */
export interface CollectedPage {
  readonly url: string;
  readonly structuralHash: string;
  readonly stateFingerprint: string;
  /** Redacted labels of any open dialogs, outermost first. Part of the state fingerprint. */
  readonly modalStack: readonly string[];
  /** Landmark holding the focused element when the page settled. Part of the state fingerprint. */
  readonly focusedLandmark: string;
  /** Absolute URLs discovered in the document, for the BFS frontier. Deduplicated. */
  readonly links: readonly string[];
  readonly elements: readonly CollectedElement[];
}
