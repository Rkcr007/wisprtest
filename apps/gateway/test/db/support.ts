import { Client } from 'pg';

/**
 * Shared plumbing for the database integration tests.
 *
 * These run against the Compose Postgres, not a mock — docs/BUILD-PLAN.md Phase 4 requires it
 * of the gateway's tests generally, and for row-level security a mock would be worse than no
 * test at all: the thing under test *is* the database's behaviour.
 */

/** Ids from `db/seed/001_fixture.sql`. Fixed so a failing assertion names a row you can look at. */
export const NORTHWIND = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  leadUserId: '22222222-2222-4222-8222-222222222221',
  testerUserId: '22222222-2222-4222-8222-222222222222',
  applicationId: '33333333-3333-4333-8333-333333333331',
  memoryVersionId: '44444444-4444-4444-8444-444444444441',
  screenId: '55555555-5555-4555-8555-555555555551',
  elementId: '66666666-6666-4666-8666-666666666661',
} as const;

/** Ids from `db/seed/002_rls_neighbour.sql` — the tenant that must stay invisible. */
export const CONTOSO = {
  tenantId: '99999999-9999-4999-8999-999999999999',
  userId: '88888888-8888-4888-8888-888888888881',
  applicationId: '88888888-8888-4888-8888-888888888882',
  memoryVersionId: '88888888-8888-4888-8888-888888888883',
} as const;

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set. Run `make db-up` and ensure .env exists (make copies it from .env.example).',
    );
  }
  return url;
}

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  return client;
}

/**
 * Run `work` as the unprivileged application role, scoped to one tenant.
 *
 * This is the shape every gateway request will take from Phase 4 onwards, and the only
 * configuration under which the policies actually apply:
 *
 * - `SET LOCAL ROLE wispr_app` — the migration user is a superuser in Compose, and superusers
 *   bypass row-level security no matter what `FORCE` says. A test that skipped this would see
 *   every tenant's rows and pass while proving nothing.
 * - `set_config(..., true)` — the `true` makes it transaction-local, so a pooled connection
 *   cannot carry one request's tenant into the next. It is also the parameterised form; plain
 *   `SET LOCAL` takes only literals, and building one by string concatenation from a tenant id
 *   is how you get an injection into the mechanism that is supposed to contain them.
 *
 * The transaction is always rolled back. These tests read a shared fixture; none of them should
 * be able to affect the next.
 */
export async function asTenant<T>(
  client: Client,
  tenantId: string,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE wispr_app');
    await client.query('SELECT set_config($1, $2, true)', ['wispr.tenant_id', tenantId]);
    return await work(client);
  } finally {
    await client.query('ROLLBACK');
  }
}

/** As {@link asTenant}, but with no tenant declared at all — the fail-closed case. */
export async function asUnscopedApp<T>(
  client: Client,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE wispr_app');
    return await work(client);
  } finally {
    await client.query('ROLLBACK');
  }
}

/** Every table the schema expects to be tenant-scoped and protected. */
export const TENANT_SCOPED_TABLES = [
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
] as const;
