import type { EvidenceStore, EvidenceUpload } from '../../src/storage/evidence-store.js';

/**
 * An in-memory evidence store, for driving the session routes without a bucket.
 *
 * The route's contract with storage is narrow — put bytes under a key, hand back an expiring URL
 * for one — and that is exactly what this implements. What the sessions suite needs to assert is
 * that a timeline resolves every key its steps reference, that it signs each distinct key once,
 * and that it refuses to sign a key belonging to another tenant. None of that is about S3, so
 * none of it should need S3 to prove.
 *
 * The real store is exercised against MinIO by the storage suite instead, where the questions are
 * about the client and the bucket rather than about the route.
 */
export interface FakeEvidenceStore extends EvidenceStore {
  /** Everything stored, by key. */
  readonly objects: Map<string, EvidenceUpload>;
  /** Every key a URL was signed for, in order — including repeats, so a test can catch them. */
  readonly signed: string[];
}

export function createFakeEvidenceStore(ttlSeconds = 300): FakeEvidenceStore {
  const objects = new Map<string, EvidenceUpload>();
  const signed: string[] = [];

  return {
    objects,
    signed,

    put(upload: EvidenceUpload): Promise<void> {
      objects.set(upload.key, upload);
      return Promise.resolve();
    },

    signedUrl(key: string): Promise<{ url: string; expiresAt: string }> {
      signed.push(key);
      return Promise.resolve({
        url: `https://evidence.test/${encodeURI(key)}?sig=fake`,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      });
    },
  };
}
