import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTenantDatabase, type TenantDatabase } from '../../src/db/pool.js';
import { cloneMemoryVersion } from '../../src/drift/clone.js';
import { createFixture, testConfig, type Fixture } from '../support/harness.js';

/**
 * Cloning a memory version.
 *
 * The riskiest SQL in the drift loop, and the kind whose mistakes are silent: a join written
 * slightly wrong produces a version that is *almost* the original, and a reviewer approving it
 * would have no way to tell. So this asserts the shape of the copy rather than that it ran —
 * counts per table, and the specific relationships that had to be re-pointed at new rows.
 *
 * The clone carries no id map. Every table is joined back on a key the schema already enforces as
 * unique, which is the same identity the gateway uses when it migrates aliases at approval time.
 * If these two ever disagreed about which element in the candidate corresponds to which in the
 * original, a tester's vocabulary would land on the wrong controls — so the correspondence is
 * asserted directly here rather than inferred from row counts.
 */

const config = testConfig();

let database: TenantDatabase;
let fixture: Fixture;
let sourceVersionId: string;
let ordersScreenId: string;
let detailScreenId: string;
let approveElementId: string;
let schemaId: string;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function fingerprint(name: string) {
  return {
    role: 'button',
    tagName: 'button',
    accessibleNameHash: HASH_C,
    accessibleNameRedacted: name,
    landmarkPath: ['main'],
    stableAttributes: { 'data-testid': name.toLowerCase() },
    ordinal: 0,
    textShingleHash: HASH_B,
    bbox: { x: 0.1, y: 0.2, width: 0.1, height: 0.04 },
  };
}

beforeAll(async () => {
  database = createTenantDatabase(config);
  fixture = await createFixture('http://127.0.0.1:1');

  const version = await fixture.client.query<{ id: string }>(
    `INSERT INTO memory_versions (tenant_id, application_id, version, status, origin)
     VALUES ($1, $2, 1, 'active', 'crawl') RETURNING id`,
    [fixture.tenantId, fixture.applicationId],
  );
  sourceVersionId = version.rows[0]?.id ?? '';

  // Two screens, so the element and edge joins have something to get wrong.
  const orders = await fixture.client.query<{ id: string }>(
    `INSERT INTO screens (tenant_id, memory_version_id, route_pattern, state_fingerprint, label, structural_hash)
     VALUES ($1, $2, '/orders', $3, 'Orders', $4) RETURNING id`,
    [fixture.tenantId, sourceVersionId, HASH_A, HASH_B],
  );
  ordersScreenId = orders.rows[0]?.id ?? '';

  const detail = await fixture.client.query<{ id: string }>(
    `INSERT INTO screens (tenant_id, memory_version_id, route_pattern, state_fingerprint, label, structural_hash)
     VALUES ($1, $2, '/orders/:id', $3, 'Order detail', $4) RETURNING id`,
    [fixture.tenantId, sourceVersionId, HASH_C, HASH_B],
  );
  detailScreenId = detail.rows[0]?.id ?? '';

  const listElement = await fixture.client.query<{ id: string }>(
    `INSERT INTO elements (tenant_id, screen_id, element_key, role, accessible_name_hash, fingerprint, confidence, stability)
     VALUES ($1, $2, 'orders.filter.pending', 'button', $3, $4, 0.9, 0.9) RETURNING id`,
    [fixture.tenantId, ordersScreenId, HASH_C, JSON.stringify(fingerprint('Pending'))],
  );

  const approve = await fixture.client.query<{ id: string }>(
    `INSERT INTO elements (tenant_id, screen_id, element_key, role, accessible_name_hash, fingerprint, confidence, stability)
     VALUES ($1, $2, 'orders.detail.approve', 'button', $3, $4, 0.95, 0.88) RETURNING id`,
    [fixture.tenantId, detailScreenId, HASH_C, JSON.stringify(fingerprint('Approve'))],
  );
  approveElementId = approve.rows[0]?.id ?? '';

  // An edge from the list to the detail page, triggered by the list's own control. Three separate
  // references that all have to be re-pointed at rows in the clone.
  await fixture.client.query(
    `INSERT INTO nav_edges (tenant_id, memory_version_id, from_screen, to_screen, trigger_element, preconditions, confidence)
     VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, 0.8)`,
    [fixture.tenantId, sourceVersionId, ordersScreenId, detailScreenId, listElement.rows[0]?.id],
  );

  const schema = await fixture.client.query<{ id: string }>(
    `INSERT INTO entity_schemas (tenant_id, memory_version_id, entity_name, observed_count, confidence, delete_flow_element_key)
     VALUES ($1, $2, 'Order', 50, 0.92, 'orders.form.order-delete') RETURNING id`,
    [fixture.tenantId, sourceVersionId],
  );
  schemaId = schema.rows[0]?.id ?? '';

  await fixture.client.query(
    `INSERT INTO field_specs (tenant_id, entity_schema_id, name, type, required, value_constraints, control_element_key)
     VALUES ($1, $2, 'status', 'enum', true, $3, 'orders-new.create-order.status')`,
    [
      fixture.tenantId,
      schemaId,
      JSON.stringify({ min: null, max: null, minLength: null, maxLength: 80, pattern: null }),
    ],
  );

  await fixture.client.query(
    `INSERT INTO materializers (tenant_id, entity_schema_id, kind, spec, priority, verified_at)
     VALUES ($1, $2, 'api', $3, 1, now())`,
    [
      fixture.tenantId,
      schemaId,
      JSON.stringify({
        kind: 'api',
        method: 'POST',
        path: '/api/v2/orders',
        payloadTemplate: { status: '{{status}}' },
        auth: 'session',
        readBackPath: '/api/v2/orders/:id',
      }),
    ],
  );

  // The tester's vocabulary. Deliberately *not* cloned — the gateway migrates it on approval and
  // counts what it loses, and a copy made here would double every phrase.
  await fixture.client.query(
    `INSERT INTO aliases (tenant_id, memory_version_id, phrase, element_id, source, hits)
     VALUES ($1, $2, 'approve it', $3, 't2_writeback', 7)`,
    [fixture.tenantId, sourceVersionId, approveElementId],
  );
}, 60_000);

afterAll(async () => {
  await fixture.drop();
  await database.close();
});

describe('cloning a memory version', () => {
  it('copies the structure, re-points every reference, and leaves the original alone', async () => {
    const clone = await database.withTenant(fixture.tenantId, (db) =>
      cloneMemoryVersion(db, fixture.tenantId, fixture.applicationId, sourceVersionId),
    );

    expect(clone.screens).toBe(2);
    expect(clone.elements).toBe(2);
    // Building and reconcile-origin: awaiting a human, and invisible to crawl resumption.
    const created = await fixture.client.query<{
      status: string;
      origin: string;
      approved_by: string | null;
    }>('SELECT status, origin, approved_by FROM memory_versions WHERE id = $1', [
      clone.memoryVersionId,
    ]);
    expect(created.rows[0]).toEqual({ status: 'building', origin: 'reconcile', approved_by: null });

    // The edge is the assertion that matters: three references, all re-pointed. If any join were
    // wrong this would either be missing or would still point into the original version.
    const edges = await fixture.client.query<{
      from_pattern: string;
      to_pattern: string;
      trigger_key: string;
      from_version: string;
    }>(
      `SELECT fs.route_pattern AS from_pattern, ts.route_pattern AS to_pattern,
              e.element_key AS trigger_key, fs.memory_version_id AS from_version
         FROM nav_edges n
         JOIN screens fs ON fs.id = n.from_screen
         JOIN screens ts ON ts.id = n.to_screen
         JOIN elements e ON e.id = n.trigger_element
        WHERE n.memory_version_id = $1`,
      [clone.memoryVersionId],
    );
    expect(edges.rows).toHaveLength(1);
    expect(edges.rows[0]?.from_pattern).toBe('/orders');
    expect(edges.rows[0]?.to_pattern).toBe('/orders/:id');
    expect(edges.rows[0]?.trigger_key).toBe('orders.filter.pending');
    expect(edges.rows[0]?.from_version).toBe(clone.memoryVersionId);

    // Elements landed on the screen with the matching fingerprint, not merged onto one screen.
    const placement = await fixture.client.query<{
      element_key: string;
      state_fingerprint: string;
    }>(
      `SELECT e.element_key, s.state_fingerprint
         FROM elements e JOIN screens s ON s.id = e.screen_id
        WHERE s.memory_version_id = $1 ORDER BY e.element_key`,
      [clone.memoryVersionId],
    );
    expect(placement.rows).toEqual([
      { element_key: 'orders.detail.approve', state_fingerprint: HASH_C },
      { element_key: 'orders.filter.pending', state_fingerprint: HASH_A },
    ]);

    // Learned data follows its entity, and a field lands under the right schema.
    const fields = await fixture.client.query<{ name: string; entity_name: string }>(
      `SELECT f.name, s.entity_name FROM field_specs f
         JOIN entity_schemas s ON s.id = f.entity_schema_id
        WHERE s.memory_version_id = $1`,
      [clone.memoryVersionId],
    );
    expect(fields.rows).toEqual([{ name: 'status', entity_name: 'Order' }]);

    // A verified materializer stays verified: the endpoint did not stop working because memory
    // was cloned, and clearing it would silently demote the fast path on every reconcile.
    const materializers = await fixture.client.query<{ kind: string; verified_at: Date | null }>(
      `SELECT m.kind, m.verified_at FROM materializers m
         JOIN entity_schemas s ON s.id = m.entity_schema_id
        WHERE s.memory_version_id = $1`,
      [clone.memoryVersionId],
    );
    expect(materializers.rows).toHaveLength(1);
    expect(materializers.rows[0]?.verified_at).not.toBeNull();

    // Aliases are the gateway's to migrate, on approval, with a count. Copying them here would
    // double every phrase and make that count meaningless.
    const aliases = await fixture.client.query(
      'SELECT id FROM aliases WHERE memory_version_id = $1',
      [clone.memoryVersionId],
    );
    expect(aliases.rowCount).toBe(0);

    // And the original is untouched — still active, still holding its own vocabulary. A session
    // resolving against it right now must not notice that a proposal was built.
    const original = await fixture.client.query<{ status: string }>(
      'SELECT status FROM memory_versions WHERE id = $1',
      [sourceVersionId],
    );
    expect(original.rows[0]?.status).toBe('active');
    const originalAliases = await fixture.client.query(
      'SELECT id FROM aliases WHERE memory_version_id = $1',
      [sourceVersionId],
    );
    expect(originalAliases.rowCount).toBe(1);
  });
});
