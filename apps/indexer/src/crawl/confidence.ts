import type { ElementFingerprint } from 'protocol';

/**
 * How sure the indexer is that a fingerprint identifies its element *uniquely on its screen*.
 *
 * Extracted from the crawler because a drift reconcile writes elements too, and it writes them
 * onto a screen whose population has just changed. A second implementation here would be a second
 * answer to the same question, and the two would be compared directly: a screen half-written by a
 * crawl and half-rewritten by a reconcile would carry confidences from two different scales, and
 * the resolver reads them as if they were one.
 *
 * It is derived, not assumed:
 *
 * - Elements sharing a role, an accessible name and a landmark path are genuinely ambiguous, and
 *   each takes a proportional share. Ten identical "View" links score 0.1 — which is correct, and
 *   which is why the resolver escalates to an ordinal rather than guessing.
 * - A stable attribute that is unique on the screen settles it: `data-testid` is "near-decisive"
 *   in ARCHITECTURE § 2, and an element carrying a unique one is unambiguous whatever else it
 *   shares.
 * - An element with neither a name nor a stable attribute is capped: it is identified only by
 *   position and role, which is the weak end of the signal table.
 */

/** The per-screen tallies confidence is relative to. Built once, read for every element. */
export interface ScreenPopulation {
  readonly identityCounts: ReadonlyMap<string, number>;
  readonly attributeCounts: ReadonlyMap<string, number>;
}

/**
 * Tally one screen's elements.
 *
 * Takes the whole population rather than being folded into the per-element call, because
 * confidence is a statement about an element *relative to its screen* — computing it from a
 * subset would score a duplicated control as unambiguous simply because its twin was not in the
 * batch.
 */
export function populationOf(fingerprints: readonly ElementFingerprint[]): ScreenPopulation {
  const identityCounts = new Map<string, number>();
  const attributeCounts = new Map<string, number>();

  for (const fingerprint of fingerprints) {
    const identity = identityOf(fingerprint);
    identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
    for (const attribute of stableAttributePairs(fingerprint)) {
      attributeCounts.set(attribute, (attributeCounts.get(attribute) ?? 0) + 1);
    }
  }

  return { identityCounts, attributeCounts };
}

export function confidenceOf(
  fingerprint: ElementFingerprint,
  population: ScreenPopulation,
): number {
  const hasUniqueAttribute = stableAttributePairs(fingerprint).some(
    (attribute) => (population.attributeCounts.get(attribute) ?? 0) === 1,
  );
  if (hasUniqueAttribute) return 1;

  const duplicates = population.identityCounts.get(identityOf(fingerprint)) ?? 1;
  const shared = 1 / duplicates;

  const hasName = fingerprint.accessibleNameRedacted.trim() !== '';
  const ceiling = hasName ? 1 : 0.5;

  return round(Math.min(shared, ceiling));
}

/** What makes two elements interchangeable to a tester: same role, same name, same place. */
function identityOf(fingerprint: ElementFingerprint): string {
  return [
    fingerprint.role,
    fingerprint.accessibleNameHash,
    fingerprint.landmarkPath.join('>'),
  ].join('|');
}

function stableAttributePairs(fingerprint: ElementFingerprint): string[] {
  return Object.entries(fingerprint.stableAttributes).map(([name, value]) => `${name}=${value}`);
}

/** Two decimal places: `numeric` in Postgres, and a confidence of 0.3333… reads as false precision. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
