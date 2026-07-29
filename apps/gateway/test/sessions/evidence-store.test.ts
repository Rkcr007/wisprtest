import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { evidenceKey, keyBelongsToTenant } from '../../src/storage/evidence-store.js';
import { createS3EvidenceStore } from '../../src/storage/s3-evidence-store.js';

/**
 * The real evidence store, against the Compose MinIO.
 *
 * The route suite runs on an in-memory store, because what it asks about is the route. This asks
 * about the client and the bucket, and those questions only have real answers against real
 * object storage: that a signed URL actually retrieves the bytes, that it carries an expiry, and
 * that the same key written twice is one object rather than two.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const SESSION = '9c5b94b1-35ad-49bb-b118-8e8fc24abf80';

function storeFromEnv() {
  const config = loadConfig(process.env);
  return { store: createS3EvidenceStore({ config }), config };
}

function pngBytes(marker: string): { body: Uint8Array; contentHash: string } {
  // Not a real PNG — the store neither parses nor validates image data, and pretending otherwise
  // would test the fixture rather than the store.
  const body = new TextEncoder().encode(`fake-png:${marker}`);
  return { body, contentHash: createHash('sha256').update(body).digest('hex') };
}

describe('S3 evidence store', () => {
  it('stores bytes and hands back a URL that retrieves them', async () => {
    const { store } = storeFromEnv();
    await store.ensureBucket();

    const { body, contentHash } = pngBytes(`retrieve-${String(Date.now())}`);
    const key = evidenceKey({
      tenantId: TENANT,
      sessionId: SESSION,
      stepOrdinal: 3,
      kind: 'screenshot',
      contentHash,
    });

    await store.put({ key, body, contentType: 'image/png' });
    const { url, expiresAt } = await store.signedUrl(key);

    const response = await fetch(url);
    expect(response.status).toBe(200);
    const retrieved = new Uint8Array(await response.arrayBuffer());
    expect(retrieved).toEqual(body);

    // The hash the database holds still verifies against what the URL served — which is the whole
    // reason evidence carries one.
    expect(createHash('sha256').update(retrieved).digest('hex')).toBe(contentHash);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
  });

  it('writes one object when the same bytes are captured twice', async () => {
    const { store } = storeFromEnv();
    await store.ensureBucket();

    const { body, contentHash } = pngBytes('idempotent');
    const key = evidenceKey({
      tenantId: TENANT,
      sessionId: SESSION,
      stepOrdinal: 7,
      kind: 'dom_snapshot',
      contentHash,
    });

    await store.put({ key, body, contentType: 'text/html' });
    await store.put({ key, body, contentType: 'text/html' });

    // The content hash is in the key, so a retried flush that re-uploads the same capture lands on
    // the same object rather than accumulating copies of one screenshot.
    const { url } = await store.signedUrl(key);
    expect((await fetch(url)).status).toBe(200);
  });

  it('creates the bucket idempotently, so boot can always call it', async () => {
    const { store } = storeFromEnv();
    await store.ensureBucket();
    await expect(store.ensureBucket()).resolves.toBeUndefined();
  });

  it('scopes keys to a tenant', () => {
    const key = evidenceKey({
      tenantId: TENANT,
      sessionId: SESSION,
      stepOrdinal: 0,
      kind: 'screenshot',
      contentHash: 'a'.repeat(64),
    });

    expect(keyBelongsToTenant(key, TENANT)).toBe(true);
    expect(keyBelongsToTenant(key, '99999999-9999-4999-8999-999999999999')).toBe(false);
    // A prefix that merely starts the same is a different tenant, not this one.
    expect(keyBelongsToTenant('tenants/1111/x', TENANT)).toBe(false);
  });
});
