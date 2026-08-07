import type {
  ElementAddition,
  ElementFingerprint,
  ElementMove,
  ElementRemoval,
  ElementRename,
  StructuralDiff,
} from 'protocol';

import { componentSegment, elementSegment } from '../crawl/element-key.js';
import type { DriftMatchResult } from './matched.js';

/**
 * Turning "what matched what" into the account a human reads before approving.
 *
 * `StructuralDiff` is the one artefact in the drift loop with a human as its audience. Everything
 * else — the candidate version, the fingerprints, the alias migration — is machinery. This is the
 * thing a QA lead reads to decide whether the change is what they expect, so its job is to be
 * *accurate about categories*, not merely complete.
 *
 * A removal and an addition describing the same button under a new name is technically complete
 * and practically useless: the reviewer is asked to approve deleting a control that is still
 * there, and cannot tell from the diff that the vocabulary pointing at it is about to be dropped.
 * That is why matching happens by score first, and why `moved` and `renamed` exist as their own
 * categories rather than as a note on a pair of unrelated entries.
 */

/** One element as memory holds it. */
export interface StoredElement {
  readonly id: string;
  readonly elementKey: string;
  readonly fingerprint: ElementFingerprint;
}

/** One element as the page now shows it, keyed by the marker the collector stamped. */
export interface ObservedElement {
  readonly marker: number;
  readonly fingerprint: ElementFingerprint;
}

export interface DiffInput {
  readonly stored: readonly StoredElement[];
  readonly observed: readonly ObservedElement[];
  readonly match: DriftMatchResult;
}

/** Landmark paths are compared as paths, not as sets: order is ancestry. */
function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * Classify every remembered and observed element into exactly one bucket.
 *
 * A matched element can be reported as both moved *and* renamed — a button that was relabelled and
 * shifted into a new landmark is genuinely both, and collapsing that to one would hide half of
 * what changed from the person deciding whether it is expected.
 */
export function computeDiff(input: DiffInput): StructuralDiff {
  const storedByKey = new Map(input.stored.map((element) => [element.elementKey, element]));
  const observedByMarker = new Map(input.observed.map((element) => [element.marker, element]));

  const moved: ElementMove[] = [];
  const renamed: ElementRename[] = [];

  for (const match of input.match.matched) {
    const before = storedByKey.get(match.elementKey);
    const after = observedByMarker.get(match.marker);
    // Unreachable unless the page pass and this one disagree about markers. Skipped rather than
    // thrown: a diff that omits one element is reviewable, and one that fails outright leaves the
    // report stuck with nothing for a human to act on.
    if (before === undefined || after === undefined) continue;

    if (!samePath(before.fingerprint.landmarkPath, after.fingerprint.landmarkPath)) {
      moved.push({
        elementKey: before.elementKey,
        elementId: before.id,
        fromLandmarkPath: [...before.fingerprint.landmarkPath],
        toLandmarkPath: [...after.fingerprint.landmarkPath],
        matchConfidence: match.score,
      });
    }

    if (before.fingerprint.accessibleNameHash !== after.fingerprint.accessibleNameHash) {
      renamed.push({
        elementKey: before.elementKey,
        elementId: before.id,
        fromNameHash: before.fingerprint.accessibleNameHash,
        toNameHash: after.fingerprint.accessibleNameHash,
        // The redacted form, never the raw name. A rename must not carry the customer's text
        // across this boundary — CLAUDE.md § "PII rule", and `drift.ts` says so on the schema.
        toNameRedacted: after.fingerprint.accessibleNameRedacted,
        matchConfidence: match.score,
      });
    }
  }

  const removed: ElementRemoval[] = input.match.missing.flatMap((key): ElementRemoval[] => {
    const element = storedByKey.get(key);
    if (element === undefined) return [];
    return [{ elementKey: key, elementId: element.id, role: element.fingerprint.role }];
  });

  const added: ElementAddition[] = input.match.unmatchedMarkers.flatMap(
    (marker): ElementAddition[] => {
      const element = observedByMarker.get(marker);
      if (element === undefined) return [];
      return [
        {
          // An addition has no element key yet: keys are minted per screen with ordinal suffixes
          // for collisions, and minting one here would guess at a numbering the next crawl
          // decides. The candidate version's own key is what the clone-and-apply step writes;
          // this is the reviewable description, so it carries what a human reads it by.
          elementKey: provisionalKey(element.fingerprint),
          role: element.fingerprint.role,
          accessibleNameRedacted: element.fingerprint.accessibleNameRedacted,
          landmarkPath: [...element.fingerprint.landmarkPath],
        },
      ];
    },
  );

  return {
    added,
    removed,
    moved,
    renamed,
    // Filled by the observer pass, which runs against the same page load. Empty here rather than
    // absent: an entity whose schema did not change is the ordinary case.
    schemaChanges: [],
  };
}

/**
 * A readable stand-in key for an element memory has never seen.
 *
 * Not minted through `ElementKeyMinter`: that assigns ordinal suffixes from document order across
 * a whole screen, and a key invented here for a *subset* of elements would collide with, or
 * disagree with, the one the write step later assigns. This exists to be read.
 *
 * The two segments still come from `crawl/element-key.ts` rather than being slugged here, so a
 * provisional key reads exactly like the real ones beside it in the diff — `region:Order Details`
 * becomes `order-details`, not `region-order-details`. A reviewer should not have to learn that
 * additions are named by a different scheme from everything else on the screen.
 */
function provisionalKey(fingerprint: ElementFingerprint): string {
  return `${componentSegment(fingerprint.landmarkPath)}.${elementSegment(fingerprint)}.new`;
}
