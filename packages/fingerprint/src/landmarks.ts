import { computeAccessibleName } from './accname.js';
import type { FingerprintConfig } from './config.js';
import { normalizeWhitespace, type Redactor } from './redact.js';
import { computeRole } from './role.js';

/**
 * Landmark and section ancestry.
 *
 * Worth 0.15 and, per the ARCHITECTURE table, "survives sibling churn" — this is the signal
 * that keeps working when a list is re-sorted, a row is inserted above, or a component's
 * internal markup is rewritten. What it records is *where in the page* an element lives, at the
 * only granularity that is stable: named regions.
 *
 * Entries are `role` or `role:name` — `main`, `region:orders`, `dialog:confirm approval` — from
 * outermost to innermost. A landmark's own name goes through the redactor first, because a
 * region can perfectly well be labelled with a customer's name.
 */

/** The ancestry path of landmark roles above (and including) an element. */
export function computeLandmarkPath(
  element: Element,
  config: FingerprintConfig,
  redact: Redactor,
): string[] {
  const landmarks = new Set(config.landmarkRoles);
  const path: string[] = [];

  // Walk up rather than querying down: an element has a handful of ancestors, while a page has
  // thousands of descendants, and this runs once per element during indexing.
  let current: Element | null = element.parentElement;
  while (current !== null) {
    const role = computeRole(current);
    if (landmarks.has(role)) {
      path.push(labelFor(current, role, redact));
    }
    current = current.parentElement;
  }

  return path.reverse();
}

function labelFor(element: Element, role: string, redact: Redactor): string {
  const name = normalizeWhitespace(computeAccessibleName(element));
  if (name === '') return role;
  return `${role}:${redact(name).toLowerCase()}`;
}

/**
 * Similarity of two landmark paths, in [0, 1].
 *
 * Compared as a shared prefix from the outside in, because that is the direction in which page
 * structure is stable: two elements in the same `main > region:orders` are related even if one
 * has since been wrapped in an extra `group`. A deeper divergence costs less than an early one.
 *
 * Two empty paths score 1 — both elements are at the top level, which is agreement, not an
 * absence of evidence.
 */
export function landmarkPathSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;

  const longest = Math.max(a.length, b.length);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) {
    shared += 1;
  }

  return shared / longest;
}
