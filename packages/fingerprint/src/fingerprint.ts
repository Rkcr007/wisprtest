import type { ElementFingerprint } from 'protocol';

import { computeAccessibleName } from './accname.js';
import { extractStableAttributes } from './attributes.js';
import { type PageContext, resolveContext, type ResolvedContext, viewportFor } from './config.js';
import { normalizeRect } from './geometry.js';
import { computeLandmarkPath } from './landmarks.js';
import { normalizeWhitespace } from './redact.js';
import { computeRole } from './role.js';
import { sha256Hex } from './sha256.js';
import { computeTextShingleHash } from './text.js';

/**
 * Fingerprint one element: all seven signals from docs/ARCHITECTURE.md § 2.
 *
 * The shape returned is `ElementFingerprint` from `packages/protocol` — this package computes
 * the contract's payload, it does not define it (CLAUDE.md rule #3).
 *
 * PII: the accessible name is redacted *before* it is hashed and before it is stored, so
 * neither `accessibleNameHash` nor `accessibleNameRedacted` can carry customer data. Hashing
 * the raw name would be worse than storing it — a digest of a customer's name is still a
 * lookup key for that name, and it would look safe.
 */
export function computeFingerprint(
  element: Element,
  context: PageContext = {},
): ElementFingerprint {
  const resolved = resolveContext(context);
  return fingerprintWith(element, resolved);
}

/** The internals, taking an already-resolved context so a batch pays defaulting once. */
export function fingerprintWith(element: Element, context: ResolvedContext): ElementFingerprint {
  const { config, redact } = context;

  const redactedName = redact(normalizeWhitespace(computeAccessibleName(element)));
  const rect = context.measure(element);

  return {
    role: computeRole(element),
    tagName: element.tagName.toLowerCase(),
    accessibleNameHash: sha256Hex(redactedName),
    accessibleNameRedacted: redactedName,
    landmarkPath: computeLandmarkPath(element, config, redact),
    stableAttributes: extractStableAttributes(element, config),
    ordinal: computeOrdinal(element),
    textShingleHash: computeTextShingleHash(element, config, redact),
    bbox: normalizeRect(rect, viewportFor(element, context)),
  };
}

/**
 * Position within the parent group, counting only siblings that share the element's role.
 *
 * Worth 0.08 — "breaks ties in lists", per the table. Counting by role rather than by raw child
 * index is what makes it survive markup churn: the third Approve button stays the third Approve
 * button when a heading or a divider is inserted above it, and a raw `:nth-child` would not.
 *
 * Returns 0 for a root element, which is the correct ordinal for something with no siblings.
 */
export function computeOrdinal(element: Element): number {
  const parent = element.parentElement;
  if (parent === null) return 0;

  const role = computeRole(element);
  let ordinal = 0;
  for (const sibling of parent.children) {
    if (sibling === element) return ordinal;
    if (computeRole(sibling) === role) ordinal += 1;
  }
  return ordinal;
}
