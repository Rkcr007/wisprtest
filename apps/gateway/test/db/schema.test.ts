import type { Client } from 'pg';
import {
  ActionClass,
  ActionOutcome,
  AliasSource,
  DriftDetector,
  DriftStatus,
  FieldType,
  MaterializerKind,
  MemoryVersionStatus,
  Tier,
  WisprError,
} from 'protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connect, NORTHWIND } from './support.js';

/**
 * The schema's contract with the rest of the system.
 *
 * Three things are asserted here that a migration alone cannot guarantee stay true:
 *
 * 1. **Enum parity.** Every CHECK constraint's value set is read back out of the catalogue and
 *    compared against the Zod enum it mirrors. `packages/protocol` is the single source of
 *    truth (CLAUDE.md rule #3), and a hand-written SQL CHECK is exactly the kind of copy that
 *    drifts silently — a value added to the protocol and forgotten here surfaces as a
 *    constraint violation in production, not at build time. This test moves it to build time.
 * 2. **Explicit delete behaviour.** Every foreign key states an ON DELETE rule, per Phase 3.
 * 3. **The query patterns Phase 3 names** have indexes, and the mutable tables have their
 *    `updated_at` trigger.
 */

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

/**
 * Read the literal values out of a `column IN ('a', 'b')` CHECK constraint.
 *
 * `pg_get_constraintdef` renders the expression in a normalised form, so the values can be
 * pulled straight back out of it. Comparing against the catalogue rather than re-reading the
 * migration file is the point: what the database actually enforces is what matters.
 */
async function checkValues(constraint: string): Promise<string[]> {
  const { rows } = await client.query<{ def: string }>(
    'SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1',
    [constraint],
  );

  const def = rows[0]?.def;
  if (def === undefined) throw new Error(`no constraint named ${constraint}`);

  return [...def.matchAll(/'((?:[^']|'')*)'/g)]
    .map((match) => (match[1] ?? '').replace(/''/g, "'"))
    .sort();
}

/**
 * The four roles, taken from the one place the contract currently states them: the
 * `forbidden` error's `requiredRole`.
 *
 * Reading them out of the union with an `in` narrowing rather than asserting a type keeps this
 * honest — if the field is ever renamed or removed, this stops compiling instead of silently
 * comparing against nothing.
 *
 * Worth noting as a contract gap rather than a test problem: the role vocabulary belongs to the
 * data model (ARCHITECTURE § 4) and to Phase 4's RBAC map, so it arguably wants its own
 * `UserRole` enum in `packages/protocol`. Adding one is a change to the contract, which is
 * outside this phase's scope.
 */
const USER_ROLES: readonly string[] = WisprError.options.flatMap((option) =>
  'requiredRole' in option.shape ? [...option.shape.requiredRole.options] : [],
);

describe('CHECK constraints match the protocol enums exactly', () => {
  it.each([
    ['users_role_check', USER_ROLES],
    ['memory_versions_status_check', MemoryVersionStatus.options],
    ['aliases_source_check', AliasSource.options],
    ['materializers_kind_check', MaterializerKind.options],
    ['seed_ledger_adapter_check', MaterializerKind.options],
    ['field_specs_type_check', FieldType.options],
    ['session_steps_tier_check', Tier.options],
    ['session_steps_action_class_check', ActionClass.options],
    ['session_steps_outcome_check', ActionOutcome.options],
    ['drift_reports_status_check', DriftStatus.options],
    ['drift_reports_detected_by_check', DriftDetector.options],
  ])('%s', async (constraint, expected) => {
    expect(await checkValues(constraint)).toEqual([...expected].sort());
  });

  it('rejects a value outside the constraint, rather than merely documenting it', async () => {
    await client.query('BEGIN');
    try {
      await expect(
        client.query(
          `INSERT INTO users (tenant_id, email, role) VALUES ($1, 'x@example.com', 'admin')`,
          [NORTHWIND.tenantId],
        ),
      ).rejects.toThrow(/users_role_check/);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('constrains the application environment, which seeding policy keys off', async () => {
    expect(await checkValues('applications_env_check')).toEqual([
      'development',
      'production',
      'staging',
    ]);
  });
});

describe('foreign keys state their delete behaviour explicitly', () => {
  it('leaves no foreign key on the implicit NO ACTION default', async () => {
    // Phase 3: "Foreign keys with explicit ON DELETE behaviour — no defaults left implicit."
    // `confdeltype` is 'a' for NO ACTION, which is also what you get by writing nothing. Any
    // key still on 'a' is one where the question was never asked.
    const { rows } = await client.query<{ conname: string; table: string }>(
      `SELECT c.conname, t.relname AS table
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public' AND c.contype = 'f' AND c.confdeltype = 'a'`,
    );

    expect(rows.map((row) => `${row.table}.${row.conname}`).sort()).toEqual([]);
  });

  it('cascades from a tenant, so offboarding removes everything', async () => {
    const { rows } = await client.query<{ conname: string; deltype: string }>(
      `SELECT c.conname, c.confdeltype AS deltype
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_class r ON r.oid = c.confrelid
        WHERE c.contype = 'f' AND r.relname = 'tenants'`,
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.deltype, `${row.conname} does not cascade from tenants`).toBe('c');
    }
  });

  it('sets null rather than cascading where a record must outlive its parent', async () => {
    // A session step must survive the element it acted on being removed by an approved drift
    // report, and the seed ledger must survive the entity schema being re-indexed — it records
    // rows that still exist in the customer's application and still need reverting.
    const { rows } = await client.query<{ conname: string; deltype: string }>(
      `SELECT conname, confdeltype AS deltype FROM pg_constraint
        WHERE conname IN ('session_steps_element_fkey', 'seed_ledger_entity_schema_fkey')`,
    );

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.deltype, `${row.conname} should SET NULL`).toBe('n');
    }
  });

  it('keeps tenant_id consistent with the owning row by composite key', async () => {
    // The denormalised `tenant_id` is only trustworthy because it cannot disagree with its
    // parent. This is that guarantee: a row whose tenant does not match its owner's is
    // unrepresentable.
    await client.query('BEGIN');
    try {
      await expect(
        client.query(
          `INSERT INTO memory_versions (tenant_id, application_id, version, status)
           VALUES ($1, $2, 99, 'building')`,
          ['99999999-9999-4999-8999-999999999999', NORTHWIND.applicationId],
        ),
      ).rejects.toThrow(/memory_versions_application_fkey/);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

describe('indexes exist for the query patterns Phase 3 names', () => {
  async function indexOn(table: string, expression: string): Promise<boolean> {
    const { rows } = await client.query<{ def: string }>(
      'SELECT indexdef AS def FROM pg_indexes WHERE schemaname = $1 AND tablename = $2',
      ['public', table],
    );
    return rows.some((row) => row.def.replace(/\s+/g, ' ').includes(expression));
  }

  it('memory snapshot load by (application_id, version)', async () => {
    expect(await indexOn('memory_versions', '(application_id, version)')).toBe(true);
  });

  it('alias lookup by (tenant_id, memory_version_id, phrase)', async () => {
    expect(await indexOn('aliases', '(tenant_id, memory_version_id, phrase)')).toBe(true);
  });

  it('ledger by session_id', async () => {
    expect(await indexOn('seed_ledger', '(session_id')).toBe(true);
  });

  it('session_steps by (session_id, ordinal)', async () => {
    expect(await indexOn('session_steps', '(session_id, ordinal)')).toBe(true);
  });

  it('enforces at most one active memory version per application', async () => {
    await client.query('BEGIN');
    try {
      await expect(
        client.query(
          `INSERT INTO memory_versions (tenant_id, application_id, version, status)
           VALUES ($1, $2, 2, 'active')`,
          [NORTHWIND.tenantId, NORTHWIND.applicationId],
        ),
      ).rejects.toThrow(/one_active_per_application/);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('dedupes aliases on (memory_version_id, phrase), the T2 write-back upsert key', async () => {
    await client.query('BEGIN');
    try {
      await expect(
        client.query(
          `INSERT INTO aliases (tenant_id, memory_version_id, phrase, element_id, source)
           VALUES ($1, $2, 'the pending filter', $3, 't2_writeback')`,
          [NORTHWIND.tenantId, NORTHWIND.memoryVersionId, NORTHWIND.elementId],
        ),
      ).rejects.toThrow(/aliases_tenant_version_phrase_key/);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

describe('updated_at is maintained by the database', () => {
  const MUTABLE_TABLES = [
    'aliases',
    'applications',
    'drift_reports',
    'entity_schemas',
    'field_specs',
    'materializers',
    'memory_versions',
    'seed_ledger',
    'sessions',
    'tenants',
    'users',
  ];

  const APPEND_ONLY_TABLES = ['audit_log', 'elements', 'nav_edges', 'screens', 'session_steps'];

  it('attaches the trigger to every table expected to mutate', async () => {
    const { rows } = await client.query<{ table: string }>(
      `SELECT c.relname AS table
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE p.proname = 'set_updated_at' AND NOT t.tgisinternal`,
    );

    expect(rows.map((row) => row.table).sort()).toEqual([...MUTABLE_TABLES].sort());
  });

  it('gives append-only tables no updated_at column at all', async () => {
    // Not an omission. An `updated_at` on the evidence trail would imply an edit path that must
    // not exist, and a column nobody maintains is worse than no column.
    const { rows } = await client.query<{ table: string }>(
      `SELECT table_name AS table FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'updated_at' AND table_name = ANY($1)`,
      [APPEND_ONLY_TABLES],
    );

    expect(rows.map((row) => row.table)).toEqual([]);
  });

  it('actually moves the timestamp on update, without the caller setting it', async () => {
    await client.query('BEGIN');
    try {
      const before = await client.query<{ updated_at: Date }>(
        'SELECT updated_at FROM applications WHERE id = $1',
        [NORTHWIND.applicationId],
      );

      // A second transaction is needed because `now()` is the transaction timestamp: an update
      // in the same transaction as the read would produce an identical value and prove nothing.
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query('UPDATE applications SET name = name WHERE id = $1', [
        NORTHWIND.applicationId,
      ]);

      const after = await client.query<{ updated_at: Date }>(
        'SELECT updated_at FROM applications WHERE id = $1',
        [NORTHWIND.applicationId],
      );

      const beforeAt = before.rows[0]?.updated_at;
      const afterAt = after.rows[0]?.updated_at;
      expect(beforeAt).toBeDefined();
      expect(afterAt).toBeDefined();
      expect(afterAt?.getTime()).toBeGreaterThan(beforeAt?.getTime() ?? 0);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

describe('every table in ARCHITECTURE § 4 exists', () => {
  it('has all sixteen, and nothing silently missing', async () => {
    const { rows } = await client.query<{ table: string }>(
      `SELECT table_name AS table FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );

    const present = rows
      .map((row) => row.table)
      .filter((name) => name !== 'atlas_schema_revisions');
    expect(present.sort()).toEqual([
      'aliases',
      'applications',
      'audit_log',
      'drift_reports',
      'elements',
      'entity_schemas',
      'field_specs',
      'materializers',
      'memory_versions',
      'nav_edges',
      'screens',
      'seed_ledger',
      'session_steps',
      'sessions',
      'tenants',
      'users',
    ]);
  });

  it('carries tenant_id on every one of them', async () => {
    // CLAUDE.md rule #7: "Every table has `tenant_id`." `tenants` satisfies it through its own
    // primary key, which is why it is excluded here and has its own policy in the migration.
    const { rows } = await client.query<{ table: string }>(
      `SELECT t.table_name AS table
         FROM information_schema.tables t
        WHERE t.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND t.table_name NOT IN ('tenants', 'atlas_schema_revisions')
          AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = t.table_schema
               AND c.table_name = t.table_name
               AND c.column_name = 'tenant_id'
          )`,
    );

    expect(rows.map((row) => row.table)).toEqual([]);
  });
});
