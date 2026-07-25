import type { ElementRecord } from 'protocol';

import type { PageContext, Rect } from './config.js';
import { computeFingerprint } from './fingerprint.js';
import type { ScopedCandidate } from './resolve.js';

/**
 * Fixture helpers for the test suite.
 *
 * Excluded from the build (`tsconfig.build.json`) and from coverage: this is scaffolding for
 * the tests, not part of the package's surface.
 *
 * The important one is {@link laidOut}. happy-dom performs no layout, so every
 * `getBoundingClientRect` returns zeroes and the geometry signal would be permanently
 * inapplicable — meaning the tests could never exercise it. Declaring rectangles per element
 * gives the suite deterministic geometry, and is the same seam the Playwright indexer uses to
 * inject measurements taken in one pass.
 */

/** Render markup into a fresh document body and return the body element. */
export function render(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

/** Find one element, failing loudly rather than returning null into an assertion. */
export function one(root: ParentNode, selector: string): Element {
  const element = root.querySelector(selector);
  if (element === null) throw new Error(`fixture has no element matching ${selector}`);
  return element;
}

/** Find several elements, asserting the expected count so a fixture edit cannot go unnoticed. */
export function many(root: ParentNode, selector: string, expected: number): Element[] {
  const elements = [...root.querySelectorAll(selector)];
  if (elements.length !== expected) {
    throw new Error(
      `fixture has ${String(elements.length)} elements matching ${selector}, expected ${String(expected)}`,
    );
  }
  return elements;
}

/**
 * A `PageContext` that measures elements from a declared layout rather than from the DOM.
 *
 * Elements absent from the map measure as a zero rect, which is how a test opts an element out
 * of the geometry signal.
 */
export function laidOut(
  layout: ReadonlyMap<Element, Rect>,
  viewport = { width: 1000, height: 1000 },
): PageContext {
  return {
    viewport,
    measure: (element) => layout.get(element) ?? { x: 0, y: 0, width: 0, height: 0 },
  };
}

const ZERO_UUID_PREFIX = '00000000-0000-4000-8000-';

/** A deterministic UUID from an index, so fixtures read as `record 1`, `record 2`. */
export function fixtureUuid(index: number): string {
  return `${ZERO_UUID_PREFIX}${String(index).padStart(12, '0')}`;
}

/**
 * Build the memory record for a live element by fingerprinting it as it currently stands.
 *
 * This is what indexing produces. Tests then mutate the DOM and resolve against the record, so
 * the drift under test is the difference between the two moments rather than something
 * hand-written into a fixture.
 */
export function recordFor(
  element: Element,
  elementKey: string,
  index: number,
  context: PageContext = {},
): ElementRecord {
  return {
    id: fixtureUuid(index),
    screenId: fixtureUuid(900),
    elementKey,
    fingerprint: computeFingerprint(element, context),
    confidence: 1,
    stability: 1,
  };
}

/**
 * Read an array element, failing loudly rather than asserting past the end.
 *
 * `noUncheckedIndexedAccess` makes every fixture index `T | undefined`, and a test that silently
 * asserts the undefined away turns a fixture typo into a confusing assertion failure ten lines
 * later instead of a clear one here.
 */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`fixture has no entry at index ${String(index)} of ${String(items.length)}`);
  }
  return item;
}

/** Pair a record with the live element it is believed to be. */
export function candidate(record: ElementRecord, element: Element): ScopedCandidate {
  return { record, element };
}
