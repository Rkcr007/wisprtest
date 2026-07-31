import {
  computeFingerprint,
  computeStateFingerprint,
  defaultRedactor,
  interactiveCandidates,
  isDisabled,
  isVisible,
  readFocusedLandmark,
  readModalStack,
  structuralHash,
  type Rect,
} from 'fingerprint';

import type { CollectedElement, CollectedPage, CollectOptions } from '../collected.js';

/**
 * Form extraction rides along on the same bundle.
 *
 * Re-exported here rather than bundled separately because the injected IIFE has one entry point
 * and one global; a second bundle would mean a second copy of `packages/fingerprint` in every
 * page. The crawler calls it after {@link collect} has stamped the markers, which is what lets a
 * control be matched back to the element key it was given.
 */
export { collectForms } from './forms.js';

/**
 * The collector, which runs inside the page under test.
 *
 * This file is bundled by esbuild and injected into every crawled document (see
 * `../fingerprint-bundle.ts`). It is the *only* indexer code that touches a DOM, and it computes
 * nothing about element identity itself: every signal comes from `packages/fingerprint`, imported
 * here and shared verbatim with the extension, per CLAUDE.md rule #4. If this file ever starts
 * deriving its own notion of what an element is, resolution at runtime breaks.
 *
 * ## What it does
 *
 * 1. Finds every interactive element, by computed role rather than by tag.
 * 2. Measures them all in one pass, then fingerprints them — so a page of two hundred controls
 *    costs one layout, not two hundred.
 * 3. Decides, per element, whether the crawler is allowed to click it.
 * 4. Hashes the page's structure and its runtime state.
 *
 * Only step 3 is the indexer's own: what a crawl is allowed to click is a property of crawling,
 * and has no counterpart at runtime. Everything else — which elements are candidates, whether one
 * is visible, and the state fingerprint the page is stored under — comes from
 * `packages/fingerprint` so the extension's RuntimeStateEngine computes it identically. A screen
 * whose fingerprint differs by a byte between the two is a screen the runtime never finds.
 *
 * ## PII
 *
 * Nothing leaves this function that has not been through the redactor. Accessible names are
 * redacted inside `computeFingerprint`; the dialog labels that make up the modal stack are
 * redacted inside `readModalStack`. No `textContent`, no `value`, no `title` is ever returned.
 */

/**
 * Whether activating this element would submit a form.
 *
 * A crawl must never commit state — this is the reversibility taxonomy applied to indexing. A
 * `<button>` inside a form defaults to `type="submit"`, which is the case people forget, so the
 * default is treated as submitting unless the author said otherwise.
 */
function isFormSubmitter(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute('type') ?? '').toLowerCase();

  if (tag === 'input') return ['submit', 'reset', 'image', 'file'].includes(type);
  if (tag !== 'button') return false;
  if (type === 'button') return false;
  if (type === 'reset') return true;

  // A `<button>` with no type, or `type="submit"`, submits its form if it has one. The missing
  // type is the case authors forget, so the absence of a type is read as "submits".
  return element.closest('form') !== null;
}

/** Whether any never-interact selector covers this element or one of its ancestors. */
function isProhibited(element: Element, selectors: readonly string[]): boolean {
  for (const selector of selectors) {
    try {
      if (element.closest(selector) !== null) return true;
    } catch {
      // An invalid selector must not silently permit an interaction the tenant prohibited. It
      // cannot match anything, so the safe reading is that the element is off-limits.
      return true;
    }
  }
  return false;
}

/** Absolute, deduplicated hrefs of in-document links, for the BFS frontier. */
function readLinks(document: Document): string[] {
  const links = new Set<string>();
  for (const anchor of document.querySelectorAll('a[href]')) {
    // `href` on an anchor is already resolved against the document base by the DOM.
    const href = anchor.getAttribute('href');
    if (href === null || href.startsWith('#')) continue;

    const resolved = (anchor as HTMLAnchorElement).href;
    if (resolved !== '') links.add(resolved.split('#')[0] ?? resolved);
  }
  return [...links];
}

/**
 * Re-apply the marker attributes without recomputing anything else.
 *
 * The crawler observes a nav edge by clicking an element and seeing where it lands, then returns
 * to the source route — which loads a fresh document, where the markers from the collection pass
 * no longer exist. Re-stamping is how the *next* candidate is addressed. It repeats the same walk
 * and the same visibility filter as {@link collect}, so marker `n` names the same element it did
 * before; a full collection would cost a fingerprint of every control to learn nothing new.
 *
 * Returns the number of elements stamped, which the crawler compares against what it collected:
 * a different count means the page did not come back the same, and the remaining markers are no
 * longer trustworthy.
 */
export function stamp(options: Pick<CollectOptions, 'markerAttribute'>): number {
  let marker = 0;
  for (const element of interactiveCandidates(document.body)) {
    const box = element.getBoundingClientRect();
    const rect: Rect = { x: box.x, y: box.y, width: box.width, height: box.height };
    if (!isVisible(element, rect)) continue;

    element.setAttribute(options.markerAttribute, String(marker));
    marker += 1;
  }
  return marker;
}

/**
 * Collect one settled route.
 *
 * Exported as the bundle's entry point; the crawler calls it through
 * `globalThis.__wisprIndexer.collect`.
 */
export function collect(options: CollectOptions): CollectedPage {
  const { body } = document;

  // Structure is hashed before anything is stamped, so the marker attribute cannot influence it
  // even by accident. (It would not: the hash reads a fixed attribute allowlist.)
  const structure = structuralHash(body);

  const candidates = interactiveCandidates(body);

  // One measurement pass, then no more layout reads. Interleaving `getBoundingClientRect` with
  // attribute writes would force a reflow per element; on a large table that is the difference
  // between a route costing 80ms and costing several seconds.
  const rects = new Map<Element, Rect>();
  for (const element of candidates) {
    const box = element.getBoundingClientRect();
    rects.set(element, { x: box.x, y: box.y, width: box.width, height: box.height });
  }

  const measure = (element: Element): Rect =>
    rects.get(element) ?? { x: 0, y: 0, width: 0, height: 0 };

  const elements: CollectedElement[] = [];
  let marker = 0;

  for (const element of candidates) {
    const rect = measure(element);
    if (!isVisible(element, rect)) continue;

    const fingerprint = computeFingerprint(element, {
      viewport: options.viewport,
      measure,
      redact: defaultRedactor,
    });

    const blockedReason = isProhibited(element, options.neverInteractSelectors)
      ? 'never_interact'
      : isDisabled(element)
        ? 'disabled'
        : isFormSubmitter(element)
          ? 'form_submitter'
          : null;

    element.setAttribute(options.markerAttribute, String(marker));

    elements.push({
      marker,
      fingerprint,
      interactable: blockedReason === null,
      blockedReason,
      href: element instanceof HTMLAnchorElement && element.href !== '' ? element.href : null,
    });
    marker += 1;
  }

  const modalStack = readModalStack(document);
  const focusedLandmark = readFocusedLandmark(document);

  return {
    url: document.location.href,
    structuralHash: structure,
    stateFingerprint: computeStateFingerprint(options.routePattern, modalStack, focusedLandmark),
    modalStack,
    focusedLandmark,
    links: readLinks(document),
    elements,
  };
}
