/**
 * Where session evidence lives.
 *
 * Screenshots and DOM snapshots are captured on check actions and on failures (docs/BUILD-PLAN.md
 * Phase 12). They are kilobytes each and a busy session produces hundreds, so the bytes go to
 * object storage and the database keeps only a reference and a content hash — which is also what
 * lets an audit prove a screenshot has not been altered since it was taken.
 *
 * ## The interface is narrow on purpose
 *
 * `put` and `signedUrl`, nothing else. No list, no delete, no overwrite: a timeline is evidence,
 * and evidence that the application holding it can quietly rewrite is not evidence. Retention is
 * a lifecycle policy on the bucket, applied by infrastructure rather than by a request handler.
 *
 * The narrowness is also what makes the route testable — the sessions suite injects an in-memory
 * store and never needs MinIO to assert that a timeline resolves its keys.
 */

/** Bytes to store, plus the content type a signed URL will serve them as. */
export interface EvidenceUpload {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface EvidenceStore {
  /** Store one artifact. Idempotent on key: the same key with the same bytes is the same object. */
  put(upload: EvidenceUpload): Promise<void>;
  /**
   * A short-lived URL for *uploading* one artifact, and nothing else.
   *
   * Pre-signed rather than proxied: a screenshot has no business transiting the gateway's request
   * pipeline, and a URL that authorises exactly one key for a few minutes is a smaller grant than
   * any credential the extension could otherwise be given.
   */
  signedUploadUrl(key: string, contentType: string): Promise<{ url: string; expiresAt: string }>;
  /**
   * A short-lived URL for retrieving one artifact.
   *
   * Expiring, because the console renders these into a page and a page gets shared. Scoped to a
   * key the caller has already proven belongs to the tenant — this function trusts its argument,
   * so the authorization must happen before the call, in the route that read the timeline.
   */
  signedUrl(key: string): Promise<{ url: string; expiresAt: string }>;
}

/**
 * The storage key for one piece of evidence.
 *
 * Tenant first, so a bucket policy or a retention rule can be written per tenant, and so a
 * listing — which this interface does not offer, but an operator has — cannot accidentally span
 * tenants. Everything after it is the path through the timeline that produced the artifact.
 */
export function evidenceKey(parts: {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly stepOrdinal: number;
  readonly kind: 'screenshot' | 'dom_snapshot';
  readonly contentHash: string;
}): string {
  const extension = parts.kind === 'screenshot' ? 'png' : 'html';
  // The content hash is in the name so the same bytes captured twice write the same object, and a
  // retried flush cannot produce a second copy of one screenshot.
  return [
    `tenants/${parts.tenantId}`,
    `sessions/${parts.sessionId}`,
    `${String(parts.stepOrdinal)}-${parts.kind}-${parts.contentHash.slice(0, 16)}.${extension}`,
  ].join('/');
}

/** Whether a key belongs to a tenant. The one authorization check this module can make locally. */
export function keyBelongsToTenant(key: string, tenantId: string): boolean {
  return key.startsWith(`tenants/${tenantId}/`);
}
