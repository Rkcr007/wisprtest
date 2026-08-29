import type { SignedEvidence } from 'protocol';

/**
 * The signed URL the gateway issued for one stored evidence key, if it issued one.
 *
 * Steps carry storage keys and content hashes; `SessionTimeline.evidence` resolves those keys
 * once. A key with no signed entry is not rendered as a link — inventing a URL would be a
 * 403, or worse, a link that pointed at the wrong tenant's object.
 */
export function signedEvidenceFor(
  evidence: readonly SignedEvidence[],
  storageKey: string,
): SignedEvidence | null {
  return evidence.find((entry) => entry.storageKey === storageKey) ?? null;
}
