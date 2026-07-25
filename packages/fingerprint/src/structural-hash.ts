import { extractStructuralAttributes } from './attributes.js';
import {
  type FingerprintConfig,
  resolveConfig,
  type FingerprintConfigOverrides,
} from './config.js';
import { computeRole } from './role.js';
import { sha256Hex } from './sha256.js';

/**
 * A hash over the shape of a subtree, deliberately blind to its content.
 *
 * This is the drift detection key. The extension computes it on every route settle and compares
 * it against memory; a mismatch raises a `DriftReport`. That makes the exclusions the whole
 * design: a hash that changed when the data changed would fire on every page of every list, and
 * a drift signal that cries wolf is worse than none, because teams learn to ignore it.
 *
 * ## What is hashed
 *
 * Per node, in document order: tag name, computed ARIA role, and the values of
 * `config.structuralAttributeNames` — `data-testid`, `name`, `type` and friends. Nesting is
 * encoded by depth markers, so moving a node into a wrapper changes the hash even though the
 * same nodes are present.
 *
 * ## What is not, and why
 *
 * - **Text content.** The point of the exclusion. Row data changes constantly; the table
 *   containing it does not.
 * - **`aria-label`, `title`, `placeholder`, `alt`, `value`.** All content. A button relabelled
 *   from "Approve" to "Approve order" is a rename, which the *fingerprint* catches at element
 *   granularity; it is not a structural change to the screen.
 * - **`class` and `style`.** A restyle is not a component change. This is the same reasoning
 *   that gives role a weight of 0.20 in the fingerprint table.
 * - **`id`.** Frequently generated, and when hand-written it is identity rather than structure.
 * - **Generated attribute values.** Recorded as present-but-anonymous (`data-testid=*`) so the
 *   hash flips when a framework starts or stops emitting one, but not on every render.
 * - **Comment and text nodes entirely**, including whitespace, so a formatter run over the
 *   templates does not read as drift.
 *
 * ## Bounds
 *
 * Descent stops at `config.maxStructuralDepth`. A page deep enough to hit it is pathological,
 * and the cap keeps this bounded on the route-settle path where it runs.
 */
export function structuralHash(root: Element, overrides?: FingerprintConfigOverrides): string {
  const config = resolveConfig(overrides);
  const parts: string[] = [];
  visit(root, config, 0, parts);
  return sha256Hex(parts.join('\n'));
}

function visit(element: Element, config: FingerprintConfig, depth: number, out: string[]): void {
  if (depth > config.maxStructuralDepth) return;

  const attributes = extractStructuralAttributes(element, config);
  const signature = [
    String(depth),
    element.tagName.toLowerCase(),
    computeRole(element),
    ...attributes,
  ].join('|');

  out.push(signature);

  for (const child of element.children) {
    visit(child, config, depth + 1, out);
  }

  // Close the node explicitly. Without a terminator, `<a><b/></a><c/>` and `<a><b/><c/></a>`
  // flatten to the same sequence of signatures — the exact reparenting a drift report is for.
  out.push(`/${String(depth)}`);
}
