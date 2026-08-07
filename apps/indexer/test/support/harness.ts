import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import type { CrawlBounds, CrawlJob } from 'protocol';

import { loadConfig, type IndexerConfig } from '../../src/config.js';

/**
 * Shared plumbing for the indexer's end-to-end suite.
 *
 * These tests run against the Compose Postgres and Redis, not against mocks. For a service whose
 * entire job is to move real pages into real rows under row-level security, a mocked database
 * would assert that the code calls the functions it calls — which is not a claim anybody needs.
 *
 * Every test creates its own tenant and application with fresh identifiers and drops them
 * afterwards, so the suite leaves nothing behind and two runs cannot collide.
 */

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set. Run `make db-up && make db-migrate`, and ensure .env exists.',
    );
  }
  return url;
}

/**
 * A complete indexer configuration for a test run.
 *
 * Read from the environment where it is set — so a developer pointing at a different Compose
 * stack is obeyed — and filled in with test-appropriate values otherwise. This is the one place
 * defaults are acceptable: they are the *test harness's* settings, not the service's, and the
 * service's own `loadConfig` still validates every one of them.
 */
export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): IndexerConfig {
  return loadConfig({
    NODE_ENV: 'test',
    // Quiet by default; `LOG_LEVEL=debug pnpm --filter indexer test:e2e` turns the crawl's own
    // narration back on, which is the fastest way to see what a failing crawl was doing.
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'error',
    INDEXER_WORKER_ID: `indexer-test-${randomUUID().slice(0, 8)}`,
    INDEXER_HOST: '127.0.0.1',
    // The suite drives the job runner directly and never starts the health server, so this is
    // only here to satisfy the same validation the service boots under.
    INDEXER_PORT: '8099',
    DATABASE_URL: databaseUrl(),
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    DB_POOL_MAX: '4',
    INDEXER_JOB_STREAM: `indexer:test:jobs:${randomUUID()}`,
    INDEXER_SEED_STREAM: `indexer:test:seed:${randomUUID()}`,
    INDEXER_SEED_CONSUMER_GROUP: 'seeders',
    INDEXER_SEED_RESULT_TTL_SECONDS: '120',
    // Per-run stream names, so two suites against the same Compose Redis cannot consume each
    // other's jobs — the same reason the crawl and seed streams are generated above.
    INDEXER_DRIFT_STREAM: `indexer:test:drift:${randomUUID()}`,
    INDEXER_DRIFT_CONSUMER_GROUP: 'reconcilers',
    INDEXER_CONSUMER_GROUP: 'indexers',
    INDEXER_BLOCK_MS: '250',
    INDEXER_CLAIM_MIN_IDLE_MS: '1000',
    INDEXER_PROGRESS_MAXLEN: '1000',
    INDEXER_HEADLESS: 'true',
    OTEL_SERVICE_NAME: 'wispr-indexer-test',
    SHUTDOWN_TIMEOUT_MS: '5000',
    ...overrides,
  });
}

export interface Fixture {
  readonly tenantId: string;
  readonly userId: string;
  readonly applicationId: string;
  readonly client: Client;
  drop(): Promise<void>;
}

/**
 * Create a tenant, a user and an application pointing at `baseUrl`.
 *
 * Inserted as the migration role, which is a superuser in Compose and therefore bypasses RLS.
 * That is correct for a fixture: the indexer's own writes go through `wispr_app` with the tenant
 * set, which is what the tests are actually exercising.
 */
export async function createFixture(baseUrl: string): Promise<Fixture> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();

  const tenantId = randomUUID();
  const userId = randomUUID();
  const applicationId = randomUUID();

  await client.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [
    tenantId,
    `indexer-test-${tenantId.slice(0, 8)}`,
  ]);
  await client.query('INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, $3, $4)', [
    userId,
    tenantId,
    `lead-${tenantId.slice(0, 8)}@northwind.example`,
    'lead',
  ]);
  await client.query(
    'INSERT INTO applications (id, tenant_id, name, base_url, env) VALUES ($1, $2, $3, $4, $5)',
    [applicationId, tenantId, `Northwind ${tenantId.slice(0, 8)}`, baseUrl, 'development'],
  );

  return {
    tenantId,
    userId,
    applicationId,
    client,
    async drop(): Promise<void> {
      // Drift reports go first, and not because they would otherwise be left behind — they
      // cascade with the tenant like everything else. `drift_reports.approved_by` is
      // `ON DELETE SET NULL`, so deleting the tenant's users nulls the approver on any decided
      // report, which violates `drift_reports_decision_needs_approver` and fails the whole drop.
      // A suite that reached a decided report could not clean up after itself at all.
      await client.query('DELETE FROM drift_reports WHERE tenant_id = $1', [tenantId]);
      // Everything else hangs off the tenant by a cascading foreign key.
      await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
      await client.end();
    },
  };
}

/** Bounds sized for the fixture application: small, fast, and explicitly prohibitive. */
export function fixtureBounds(baseUrl: string, overrides: Partial<CrawlBounds> = {}): CrawlBounds {
  return {
    allowedOrigins: [baseUrl],
    routeAllowlist: ['/'],
    maxDepth: 3,
    maxPages: 20,
    // The two controls in the fixture that destroy data. Neither is distinguishable from a safe
    // control by its markup, which is the point of the list existing.
    neverInteractSelectors: ['[data-testid="order-delete"]', '[data-testid="settings-purge"]'],
    maxInteractionsPerRoute: 8,
    // Short, because the fixture is local and every non-navigating click is paid in full here.
    interactionObserveMs: 300,
    settleDelayMs: 50,
    networkIdleTimeoutMs: 2_000,
    navigationTimeoutMs: 10_000,
    requestsPerMinute: 600,
    viewport: { width: 1280, height: 720 },
    ...overrides,
  };
}

export function fixtureJob(fixture: Fixture, baseUrl: string, bounds: CrawlBounds): CrawlJob {
  return {
    jobId: randomUUID(),
    tenantId: fixture.tenantId,
    applicationId: fixture.applicationId,
    baseUrl,
    bounds,
    authProfile: { kind: 'none' },
    requestedBy: fixture.userId,
    requestedAt: new Date().toISOString(),
    traceparent: null,
  };
}

export interface MemoryContents {
  readonly version: { id: string; version: number; status: string; failureReason: string | null };
  readonly screens: { id: string; routePattern: string; label: string; stateFingerprint: string }[];
  readonly elements: { screenId: string; elementKey: string; role: string; fingerprint: unknown }[];
  readonly edges: { fromScreen: string; toScreen: string; triggerElement: string }[];
}

/** Read back everything a crawl wrote, for assertions. */
export async function readMemory(
  client: Client,
  applicationId: string,
): Promise<MemoryContents | null> {
  const versions = await client.query<{
    id: string;
    version: number;
    status: string;
    failure_reason: string | null;
  }>(
    'SELECT id, version, status, failure_reason FROM memory_versions WHERE application_id = $1 ORDER BY version DESC LIMIT 1',
    [applicationId],
  );
  const version = versions.rows[0];
  if (version === undefined) return null;

  const screens = await client.query<{
    id: string;
    route_pattern: string;
    label: string;
    state_fingerprint: string;
  }>(
    'SELECT id, route_pattern, label, state_fingerprint FROM screens WHERE memory_version_id = $1 ORDER BY route_pattern',
    [version.id],
  );

  const elements = await client.query<{
    screen_id: string;
    element_key: string;
    role: string;
    fingerprint: unknown;
  }>(
    `SELECT e.screen_id, e.element_key, e.role, e.fingerprint
       FROM elements e JOIN screens s ON s.id = e.screen_id
      WHERE s.memory_version_id = $1
      ORDER BY e.element_key`,
    [version.id],
  );

  const edges = await client.query<{
    from_screen: string;
    to_screen: string;
    trigger_element: string;
  }>('SELECT from_screen, to_screen, trigger_element FROM nav_edges WHERE memory_version_id = $1', [
    version.id,
  ]);

  return {
    version: {
      id: version.id,
      version: version.version,
      status: version.status,
      failureReason: version.failure_reason,
    },
    screens: screens.rows.map((row) => ({
      id: row.id,
      routePattern: row.route_pattern,
      label: row.label,
      stateFingerprint: row.state_fingerprint,
    })),
    elements: elements.rows.map((row) => ({
      screenId: row.screen_id,
      elementKey: row.element_key,
      role: row.role,
      fingerprint: row.fingerprint,
    })),
    edges: edges.rows.map((row) => ({
      fromScreen: row.from_screen,
      toScreen: row.to_screen,
      triggerElement: row.trigger_element,
    })),
  };
}

/** One learned entity, with everything hanging off it, as the observers wrote it. */
export interface LearnedEntity {
  readonly id: string;
  readonly entityName: string;
  readonly observedCount: number;
  readonly confidence: number;
  /** The indexed control that removes one record, or null when none was found. */
  readonly deleteFlowElementKey: string | null;
  readonly fields: readonly LearnedField[];
  readonly materializers: readonly LearnedMaterializer[];
}

export interface LearnedField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly derivedRule: unknown;
  readonly enumValues: unknown;
  readonly distribution: unknown;
  readonly referencesEntity: string | null;
  readonly valueConstraints: unknown;
  readonly controlElementKey: string | null;
  readonly unique: boolean;
}

export interface LearnedMaterializer {
  readonly kind: string;
  readonly spec: unknown;
  readonly priority: number;
  readonly verifiedAt: Date | null;
}

/**
 * Read back every entity schema written against a memory version.
 *
 * Raw rows rather than parsed contract objects, on purpose: the observers' suite asserts that
 * what reached Postgres validates against `packages/protocol`, and it cannot do that if the
 * reader has already validated it on the way out.
 */
export async function readSchemas(
  client: Client,
  memoryVersionId: string,
): Promise<LearnedEntity[]> {
  const entities = await client.query<{
    id: string;
    entity_name: string;
    observed_count: number;
    confidence: string;
    delete_flow_element_key: string | null;
  }>(
    `SELECT id, entity_name, observed_count, confidence, delete_flow_element_key
       FROM entity_schemas WHERE memory_version_id = $1 ORDER BY entity_name`,
    [memoryVersionId],
  );

  const fields = await client.query<{
    entity_schema_id: string;
    name: string;
    type: string;
    required: boolean;
    derived_rule: unknown;
    enum_values: unknown;
    distribution: unknown;
    references_entity: string | null;
    value_constraints: unknown;
    control_element_key: string | null;
    is_unique: boolean;
  }>(
    `SELECT f.* FROM field_specs f
       JOIN entity_schemas e ON e.id = f.entity_schema_id
      WHERE e.memory_version_id = $1 ORDER BY f.name`,
    [memoryVersionId],
  );

  const materializers = await client.query<{
    entity_schema_id: string;
    kind: string;
    spec: unknown;
    priority: number;
    verified_at: Date | null;
  }>(
    `SELECT m.* FROM materializers m
       JOIN entity_schemas e ON e.id = m.entity_schema_id
      WHERE e.memory_version_id = $1 ORDER BY m.priority`,
    [memoryVersionId],
  );

  return entities.rows.map((entity) => ({
    id: entity.id,
    entityName: entity.entity_name,
    observedCount: entity.observed_count,
    confidence: Number(entity.confidence),
    deleteFlowElementKey: entity.delete_flow_element_key,
    fields: fields.rows
      .filter((field) => field.entity_schema_id === entity.id)
      .map((field) => ({
        name: field.name,
        type: field.type,
        required: field.required,
        derivedRule: field.derived_rule,
        enumValues: field.enum_values,
        distribution: field.distribution,
        referencesEntity: field.references_entity,
        valueConstraints: field.value_constraints,
        controlElementKey: field.control_element_key,
        unique: field.is_unique,
      })),
    materializers: materializers.rows
      .filter((materializer) => materializer.entity_schema_id === entity.id)
      .map((materializer) => ({
        kind: materializer.kind,
        spec: materializer.spec,
        priority: materializer.priority,
        verifiedAt: materializer.verified_at,
      })),
  }));
}

/** Poll until `predicate` holds, or fail with a message naming what was being waited for. */
export async function waitFor(
  what: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what}`);
}
