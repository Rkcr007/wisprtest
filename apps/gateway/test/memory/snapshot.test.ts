import { gunzipSync } from 'node:zlib';

import { MemorySnapshot } from 'protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { tenantKey } from '../../src/redis/client.js';
import { NEIGHBOUR, SEED, startHarness, type Harness } from '../support/harness.js';

/**
 * The memory endpoints, against the real stack.
 *
 * The seed fixture (`db/seed/001_fixture.sql`) gives us an active version 1 for the Northwind
 * application: one screen, one element, one indexed alias. That is enough to assert the snapshot
 * is assembled correctly, compressed, cached and tenant-scoped, and that the write-back
 * deduplicates and bumps hits — without standing up a crawl.
 */

let harness: Harness;

// Ids from `db/seed/001_fixture.sql`.
const PENDING_ELEMENT_ID = '66666666-6666-4666-8666-666666666661';
// A phrase this suite owns, so it can clean up after itself and never touch the indexed alias.
const WRITEBACK_PHRASE = 'wispr-test show me the pending ones';

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  // Leave the seed as we found it: drop the aliases this suite wrote back, and the cached
  // snapshot for the version, so a rerun starts clean.
  await harness.database.unscoped('readiness-probe', (db) =>
    db
      .deleteFrom('aliases')
      .where('memoryVersionId', '=', SEED.memoryVersionId)
      .where('source', 'in', ['t2_writeback', 'manual'])
      .execute(),
  );
  await harness.redis.del(tenantKey(SEED.tenantId, 'memory', SEED.applicationId, 'v1'));
  await harness.close();
});

async function get(email: string, appId: string) {
  const token = await harness.issuer.sign({ email });
  return harness.app.inject({
    method: 'GET',
    url: `/v1/memory/${appId}/snapshot`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function decode(rawPayload: Buffer): MemorySnapshot {
  return MemorySnapshot.parse(JSON.parse(gunzipSync(rawPayload).toString('utf8')));
}

describe('GET /v1/memory/:appId/snapshot', () => {
  it('returns a compressed, contract-valid snapshot for the active version', async () => {
    const response = await get(SEED.leadEmail, SEED.applicationId);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    // A shared cache must never keep one tenant's memory.
    expect(response.headers['cache-control']).toBe('private, no-store');

    // The body is gzip on the wire; `inject` hands back the raw bytes, and it parses against the
    // contract once decompressed — which is the whole assertion that it is a real MemorySnapshot.
    const snapshot = decode(response.rawPayload);

    expect(snapshot.tenantId).toBe(SEED.tenantId);
    expect(snapshot.applicationId).toBe(SEED.applicationId);
    expect(snapshot.memoryVersion.version).toBe(1);
    expect(snapshot.memoryVersion.status).toBe('active');

    expect(snapshot.screens.map((screen) => screen.routePattern)).toContain('/orders');
    expect(snapshot.elements.map((element) => element.elementKey)).toContain(
      'orders.filter.pending',
    );
    // Structure, never content: the accessible name is a digest plus a redacted display form.
    const pending = snapshot.elements.find(
      (element) => element.elementKey === 'orders.filter.pending',
    );
    expect(pending?.fingerprint.accessibleNameRedacted).toBe('Pending');
    expect(pending).not.toHaveProperty('accessibleName');

    expect(snapshot.aliases.map((alias) => alias.phrase)).toContain('the pending filter');
  });

  it('serves a second request from the version-keyed cache', async () => {
    const first = decode((await get(SEED.leadEmail, SEED.applicationId)).rawPayload);
    const second = decode((await get(SEED.leadEmail, SEED.applicationId)).rawPayload);

    // `generatedAt` is stamped when a snapshot is assembled. Two fetches with the same stamp means
    // the second was served from the cache rather than rebuilt — the property the version key
    // exists to provide.
    expect(second.generatedAt).toBe(first.generatedAt);

    const exists = await harness.redis.exists(
      tenantKey(SEED.tenantId, 'memory', SEED.applicationId, 'v1'),
    );
    expect(exists).toBe(1);
  });

  it('answers 503 when an application has no active version', async () => {
    // The neighbour's application has a version, but it is still `building` — a real "not ready
    // yet", not an error.
    const response = await get(NEIGHBOUR.ownerEmail, NEIGHBOUR.applicationId);

    expect(response.statusCode).toBe(503);
    expect(response.json<{ code: string }>().code).toBe('memory_snapshot_unavailable');
  });

  it('does not leak another tenant’s memory', async () => {
    // The lead belongs to the seed tenant and asks for the neighbour's application. Row-level
    // security makes that application invisible, so the answer is the same 503 as an unknown id —
    // never the neighbour's snapshot.
    const response = await get(SEED.leadEmail, NEIGHBOUR.applicationId);

    expect(response.statusCode).toBe(503);
    expect(response.json<{ code: string }>().code).toBe('memory_snapshot_unavailable');
  });

  it('requires authentication', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/memory/${SEED.applicationId}/snapshot`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /v1/memory/aliases', () => {
  async function writeBack(email: string, body: unknown) {
    const token = await harness.issuer.sign({ email });
    return harness.app.inject({
      method: 'POST',
      url: '/v1/memory/aliases',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      // Serialised explicitly: a `payload` typed `unknown` defeats inject's overload resolution,
      // and a string body with the content type is what the route parses anyway.
      payload: JSON.stringify(body),
    });
  }

  it('inserts a new alias, then deduplicates and bumps hits on the same phrase', async () => {
    const item = {
      phrase: WRITEBACK_PHRASE,
      elementId: PENDING_ELEMENT_ID,
      stateFingerprint: null,
      source: 't2_writeback',
    };
    const batch = { memoryVersionId: SEED.memoryVersionId, items: [item] };

    const first = await writeBack(SEED.leadEmail, batch);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ accepted: 1, inserted: 1, updated: 0 });

    const second = await writeBack(SEED.leadEmail, batch);
    expect(second.json()).toEqual({ accepted: 1, inserted: 0, updated: 1 });

    // The write-back dropped the cached snapshot, so this fetch rebuilds it — and the new alias
    // is present, with two hits, proving the increment landed on one row rather than a duplicate.
    const snapshot = decode((await get(SEED.leadEmail, SEED.applicationId)).rawPayload);
    const written = snapshot.aliases.filter((alias) => alias.phrase === WRITEBACK_PHRASE);
    expect(written).toHaveLength(1);
    expect(written[0]?.hits).toBe(2);
    expect(written[0]?.source).toBe('t2_writeback');
  });

  it('rejects a batch naming a memory version the tenant cannot see', async () => {
    const response = await writeBack(SEED.leadEmail, {
      // A well-formed UUID that names no version this tenant owns. RLS makes it read as absent.
      memoryVersionId: '00000000-0000-4000-8000-000000000abc',
      items: [
        {
          phrase: 'wispr-test orphan',
          elementId: PENDING_ELEMENT_ID,
          stateFingerprint: null,
          source: 'manual',
        },
      ],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('validation_failed');
  });

  it('rejects an empty batch', async () => {
    const response = await writeBack(SEED.leadEmail, {
      memoryVersionId: SEED.memoryVersionId,
      items: [],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('validation_failed');
  });
});
