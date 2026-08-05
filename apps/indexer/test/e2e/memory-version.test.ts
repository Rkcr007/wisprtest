import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTenantDatabase, type TenantDatabase } from '../../src/db/pool.js';
import { openMemoryVersion } from '../../src/db/memory-repository.js';
import { createFixture, testConfig, type Fixture } from '../support/harness.js';

/**
 * Which `building` version a crawl is allowed to resume.
 *
 * A regression test for a collision Phase 17 introduces and Phase 5 could not have anticipated.
 * `openMemoryVersion` resumes an in-progress version so a crawl that died mid-run picks up where
 * it stopped — correct, and the only producer of such a version used to be a crawl.
 *
 * A drift reconcile now produces one too: it clones the active version, applies what it observed,
 * and leaves the clone `building` for a human to activate. If a crawl resumed *that*, it would
 * write a full re-crawl into a reviewed proposal, and the reviewer would approve a version that is
 * nothing like the diff they read.
 *
 * Nothing about that failure is loud. There is no error, no constraint violation and no log line —
 * just a memory version that means something other than what the approval said. Which is why the
 * distinction is a column and this test exists to hold it.
 */

const config = testConfig();

let database: TenantDatabase;
let fixture: Fixture;

beforeAll(async () => {
  database = createTenantDatabase(config);
  // No application is crawled here; the base URL only has to be a URL.
  fixture = await createFixture('http://127.0.0.1:1');
}, 60_000);

afterAll(async () => {
  await fixture.drop();
  await database.close();
});

/** Insert a `building` version directly, the way each producer leaves one behind. */
async function building(version: number, origin: 'crawl' | 'reconcile'): Promise<string> {
  const row = await fixture.client.query<{ id: string }>(
    `INSERT INTO memory_versions (tenant_id, application_id, version, status, origin)
     VALUES ($1, $2, $3, 'building', $4) RETURNING id`,
    [fixture.tenantId, fixture.applicationId, version, origin],
  );
  return row.rows[0]?.id ?? '';
}

async function open() {
  return database.withTenant(fixture.tenantId, (db) =>
    openMemoryVersion(db, fixture.tenantId, fixture.applicationId),
  );
}

describe('opening a memory version for a crawl', () => {
  it('resumes a crawl that was interrupted', async () => {
    const interrupted = await building(1, 'crawl');

    const opened = await open();

    expect(opened.resumed).toBe(true);
    expect(opened.id).toBe(interrupted);

    await fixture.client.query('DELETE FROM memory_versions WHERE id = $1', [interrupted]);
  });

  it('never resumes a drift candidate, and does not disturb it', async () => {
    const candidate = await building(2, 'reconcile');

    const opened = await open();

    // A fresh version, not the proposal awaiting review.
    expect(opened.resumed).toBe(false);
    expect(opened.id).not.toBe(candidate);

    // And the candidate is untouched — still building, still a reconcile, still version 2.
    const after = await fixture.client.query<{ status: string; origin: string }>(
      'SELECT status, origin FROM memory_versions WHERE id = $1',
      [candidate],
    );
    expect(after.rows[0]).toEqual({ status: 'building', origin: 'reconcile' });

    // The new version takes the next number, so the candidate's is not reused either.
    expect(opened.version).toBe(3);

    await fixture.client.query('DELETE FROM memory_versions WHERE id = ANY($1)', [
      [candidate, opened.id],
    ]);
  });

  it('resumes the crawl even when a drift candidate is newer', async () => {
    // The ordering case. `openMemoryVersion` takes the highest version, so a candidate minted
    // after an interrupted crawl would win on `version DESC` if the origin filter were dropped.
    const interrupted = await building(4, 'crawl');
    const candidate = await building(5, 'reconcile');

    const opened = await open();

    expect(opened.resumed).toBe(true);
    expect(opened.id).toBe(interrupted);

    await fixture.client.query('DELETE FROM memory_versions WHERE id = ANY($1)', [
      [interrupted, candidate],
    ]);
  });

  it('records what produced a version it creates', async () => {
    const opened = await open();

    const row = await fixture.client.query<{ origin: string }>(
      'SELECT origin FROM memory_versions WHERE id = $1',
      [opened.id],
    );
    expect(row.rows[0]?.origin).toBe('crawl');

    await fixture.client.query('DELETE FROM memory_versions WHERE id = $1', [opened.id]);
  });
});
