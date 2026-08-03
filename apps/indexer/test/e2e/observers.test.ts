import { Redis } from 'ioredis';
import { pino } from 'pino';
import type { Browser } from 'playwright';
import { DerivedRule, DistributionShape, FieldValueConstraints, MaterializerSpec } from 'protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchBrowser } from '../../src/crawl/browser.js';
import { createSecretResolver } from '../../src/crawl/secrets.js';
import { createTenantDatabase, type TenantDatabase } from '../../src/db/pool.js';
import { runJob, type JobRunnerDependencies } from '../../src/job-runner.js';
import type { EntitySchemaDraft } from '../../src/observers/consolidate.js';
import { persistSchemas } from '../../src/observers/repository.js';
import { createRedis } from '../../src/redis/client.js';
import { createMetrics } from '../../src/telemetry/metrics.js';
import { startFixtureApp, type FixtureApp } from '../fixture-app/server.js';
import {
  createFixture,
  fixtureBounds,
  fixtureJob,
  readMemory,
  readSchemas,
  testConfig,
  type Fixture,
  type LearnedEntity,
  type LearnedField,
} from '../support/harness.js';

/**
 * The schema observers, end to end, against a real application.
 *
 * The gate for docs/BUILD-PLAN.md Phase 13. Nothing here is mocked: a real browser crawls a real
 * Express application, the application's own scripts issue the API calls the observers learn
 * from, and every assertion is read back out of Postgres.
 *
 * What is asserted is not "the observers ran". It is that a specific application produced a
 * specific body of per-application knowledge — the entity, its enum vocabularies, its
 * distributions, its referential edge, its derived rules and both kinds of materializer — and
 * that none of the customer data those were computed from came with them.
 */

const config = testConfig();

let browser: Browser;
let database: TenantDatabase;
let redis: Redis;
let app: FixtureApp;
let fixture: Fixture;
let entities: LearnedEntity[];
let order: LearnedEntity;

const logger = pino({ level: config.LOG_LEVEL });

/** Every string in the fixture's data that must never reach a persisted schema. */
const SENTINELS: readonly string[] = [
  'Wexford Maritime Holdings',
  'Kilnhurst Diaphragms',
  'Ingrid Sollenberg',
  'Marta Feldsted',
  'Osric Vandeleur',
  'northwind.example',
  'Reconditioned drive coupling',
  'Bespoke gasket set',
];

function dependencies(): JobRunnerDependencies {
  return {
    database,
    redis,
    browser,
    secrets: createSecretResolver(),
    metrics: createMetrics(),
    logger,
    progressMaxLength: config.INDEXER_PROGRESS_MAXLEN,
  };
}

function fieldNamed(entity: LearnedEntity, name: string): LearnedField {
  const field = entity.fields.find((candidate) => candidate.name === name);
  if (field === undefined) {
    throw new Error(
      `${entity.entityName} has no field ${name}; it has: ${entity.fields
        .map((candidate) => candidate.name)
        .join(', ')}`,
    );
  }
  return field;
}

beforeAll(async () => {
  browser = await launchBrowser(true);
  database = createTenantDatabase(config);
  redis = createRedis(config);
  await redis.connect();

  app = await startFixtureApp();
  fixture = await createFixture(app.url);

  const job = fixtureJob(fixture, app.url, fixtureBounds(app.url));
  const outcome = await runJob(job, dependencies(), new AbortController().signal);
  expect(outcome.status).toBe('completed');

  const memory = await readMemory(fixture.client, fixture.applicationId);
  if (memory === null) throw new Error('the crawl wrote no memory version');

  entities = await readSchemas(fixture.client, memory.version.id);
  const learned = entities.find((entity) => entity.entityName === 'Order');
  if (learned === undefined) {
    throw new Error(`no Order schema; learned: ${entities.map((e) => e.entityName).join(', ')}`);
  }
  order = learned;
}, 240_000);

afterAll(async () => {
  await fixture.drop();
  await app.close();
  await browser.close();
  await database.close();
  await redis.quit();
});

describe('entity schemas', () => {
  it('names the entities both channels found, against the memory version', () => {
    // `Order` from the create form *and* the list endpoint; `Account` from the API alone, which
    // is what makes the referential edge below possible; `Setting` from the settings form alone.
    expect(entities.map((entity) => entity.entityName)).toEqual(['Account', 'Order', 'Setting']);

    expect(order.observedCount).toBe(50);
    // Both channels, a materializer of each kind, and fifty records behind the distributions.
    expect(order.confidence).toBeGreaterThan(0.8);

    // An entity seen only as a form can be created but every value would be a guess, and the
    // confidence says so rather than claiming the schema is understood.
    const setting = entities.find((entity) => entity.entityName === 'Setting');
    expect(setting?.observedCount).toBe(0);
    expect(setting?.confidence).toBeLessThan(order.confidence);
  });

  it('reads requiredness and validation off the form, which is the only place they exist', () => {
    const customer = fieldNamed(order, 'customer');
    expect(customer.required).toBe(true);
    expect(FieldValueConstraints.parse(customer.valueConstraints).maxLength).toBe(80);

    const poNumber = fieldNamed(order, 'po_number');
    expect(poNumber.required).toBe(true);
    // The form declares the shape the application will actually accept.
    expect(FieldValueConstraints.parse(poNumber.valueConstraints).pattern).toBe('PO-[0-9]{4}');

    // Merged across the two spellings: `poNumber` on the form, `po_number` in the payload. One
    // field, stored under the name the records use.
    expect(
      order.fields.filter((field) => field.name.toLowerCase().includes('number')),
    ).toHaveLength(1);

    // Every control the UI materializer will have to drive names an element the crawl indexed.
    expect(customer.controlElementKey).toBe('orders-new.create-order.customer');
    const amount = fieldNamed(order, 'amount');
    expect(amount.controlElementKey).toBe('orders-new.create-order.amount');
  });

  it('learns the repeatable group and flattens its members', () => {
    const lines = fieldNamed(order, 'lines');
    expect(lines.type).toBe('group');
    // A "three line items" cardinality constraint is checked against this.
    const shape = DistributionShape.parse((lines.distribution as { shape: unknown }).shape);
    expect(shape.kind).toBe('numeric');

    const lineAmount = fieldNamed(order, 'lines.amount');
    expect(lineAmount.type).toBe('number');
    expect(lineAmount.distribution).not.toBeNull();
  });
});

describe('enum vocabularies', () => {
  it('learns the closed sets, from the records and from the controls that declare them', () => {
    const status = fieldNamed(order, 'status');
    expect(status.type).toBe('enum');
    expect(status.enumValues).toEqual(['approved', 'cancelled', 'pending', 'shipped']);

    const terms = fieldNamed(order, 'terms');
    expect(terms.type).toBe('enum');
    expect(terms.enumValues).toEqual(['net15', 'net30', 'net60']);

    // Frequencies come from real data, not from the option order in the markup.
    const shape = DistributionShape.parse((status.distribution as { shape: unknown }).shape);
    if (shape.kind !== 'categorical') throw new Error('expected a categorical distribution');
    expect(Object.keys(shape.frequencies).sort()).toEqual([
      'approved',
      'cancelled',
      'pending',
      'shipped',
    ]);
  });

  it('refuses to treat a column of customer names as a vocabulary', () => {
    const customer = fieldNamed(order, 'customer');
    expect(customer.type).not.toBe('enum');
    expect(customer.enumValues).toBeNull();

    // Only its shape survived: a length range and a character class, and no shared prefix,
    // because a prefix long enough to cover a name is a name.
    const shape = DistributionShape.parse((customer.distribution as { shape: unknown }).shape);
    if (shape.kind !== 'string_pattern') throw new Error('expected a learned string shape');
    expect(shape.prefix).toBeNull();
    expect(shape.minLength).toBeGreaterThan(0);
  });
});

describe('distributions', () => {
  it('computes numeric ranges from the real records', () => {
    const amount = fieldNamed(order, 'amount');
    const distribution = amount.distribution as { shape: unknown; sampleSize: number };
    expect(distribution.sampleSize).toBe(50);

    const shape = DistributionShape.parse(distribution.shape);
    if (shape.kind !== 'numeric') throw new Error('expected a numeric distribution');

    // The real spread of the fixture's fifty orders, which is what a sampler has to draw inside.
    const amounts = app.state.orders.map((entry) => entry.amount);
    expect(shape.min).toBeCloseTo(Math.min(...amounts), 2);
    expect(shape.max).toBeCloseTo(Math.max(...amounts), 2);
    expect(shape.mean).toBeGreaterThan(shape.min);
    expect(shape.mean).toBeLessThan(shape.max);
  });

  it('learns string shapes and date ranges', () => {
    const reference = DistributionShape.parse(
      (fieldNamed(order, 'reference').distribution as { shape: unknown }).shape,
    );
    if (reference.kind !== 'string_pattern') throw new Error('expected a learned string shape');
    expect(reference.prefix?.startsWith('ORD-')).toBe(true);
    expect(reference.minLength).toBe(8);
    expect(reference.maxLength).toBe(8);

    const created = DistributionShape.parse(
      (fieldNamed(order, 'createdAt').distribution as { shape: unknown }).shape,
    );
    if (created.kind !== 'temporal') throw new Error('expected a temporal distribution');
    // Expressed as offsets from now, which is how a predicate over dates has to be solved.
    expect(created.minOffsetDays).toBeLessThan(created.maxOffsetDays);
    expect(created.maxOffsetDays).toBeLessThan(0);
  });

  it('marks the identifier columns unique and leaves the rest alone', () => {
    expect(fieldNamed(order, 'reference').unique).toBe(true);
    expect(fieldNamed(order, 'customer').unique).toBe(false);
  });
});

describe('the referential graph', () => {
  it('finds the edge by matching values across collections, not by being told', () => {
    const account = fieldNamed(order, 'accountId');
    expect(account.type).toBe('reference');
    expect(account.referencesEntity).toBe('Account');

    // A reference resolves against real records rather than being sampled, so keeping a
    // distribution would be keeping a list of somebody's primary keys with nothing reading it.
    expect(account.distribution).toBeNull();
    expect(account.enumValues).toBeNull();

    // The target really was learned as an entity of its own.
    const target = entities.find((entity) => entity.entityName === 'Account');
    expect(target?.observedCount).toBe(app.state.accounts.length);
  });
});

describe('derived rules', () => {
  it('records only hypotheses that held for every observed record', () => {
    const ruleFor = (name: string): DerivedRule =>
      DerivedRule.parse(fieldNamed(order, name).derivedRule);

    const amount = ruleFor('amount');
    expect(amount.rule).toEqual({ kind: 'sum', overField: 'lines', ofField: 'amount' });
    expect(amount.sampleSize).toBe(50);
    expect(amount.confidence).toBe(1);

    expect(ruleFor('lineCount').rule).toEqual({ kind: 'count', overField: 'lines' });
    expect(ruleFor('largestLine').rule).toEqual({
      kind: 'max',
      overField: 'lines',
      ofField: 'amount',
    });
    expect(ruleFor('dueAt').rule).toEqual({
      kind: 'date_offset',
      fromField: 'createdAt',
      offsetDays: 30,
    });
    expect(ruleFor('title').rule).toEqual({
      kind: 'concat',
      fields: ['reference', 'po_number'],
      separator: ' · ',
    });

    // The other direction of the same relationship also holds across every record, and recording
    // both would leave the solver with two fields each waiting on the other.
    expect(fieldNamed(order, 'createdAt').derivedRule).toBeNull();

    // Nothing was invented for a field that is simply a value.
    expect(fieldNamed(order, 'customer').derivedRule).toBeNull();
    expect(fieldNamed(order, 'status').derivedRule).toBeNull();
  });
});

describe('materializers', () => {
  it('records the UI path from the form and the API path from observed traffic', () => {
    expect(order.materializers.map((materializer) => materializer.kind).sort()).toEqual([
      'api',
      'ui',
    ]);

    const ui = order.materializers.find((materializer) => materializer.kind === 'ui');
    const uiSpec = MaterializerSpec.parse(ui?.spec);
    if (uiSpec.kind !== 'ui') throw new Error('expected a UI materializer');
    expect(uiSpec.form).toBe('orders-new.create-order');
    expect(uiSpec.route).toBe('/orders/new');
    // Priority 2, per docs/TEST-DATA-ENGINE.md § 4: slower, and always available.
    expect(ui?.priority).toBe(2);

    const api = order.materializers.find((materializer) => materializer.kind === 'api');
    const apiSpec = MaterializerSpec.parse(api?.spec);
    if (apiSpec.kind !== 'api') throw new Error('expected an API materializer');
    expect(apiSpec.method).toBe('POST');
    expect(apiSpec.path).toBe('/api/v2/orders');
    expect(apiSpec.readBackPath).toBe('/api/v2/orders/:id');
    expect(api?.priority).toBe(1);

    // Unverified, and it must stay that way: nothing in a crawl can prove that replaying this
    // request creates a record, because proving it means creating one.
    expect(api?.verifiedAt).toBeNull();

    // The payload is stored as slots, never as the values that were observed in it.
    expect(apiSpec.payloadTemplate).toEqual({
      accountId: '{{accountId}}',
      customer: '{{customer}}',
      po_number: '{{po_number}}',
      status: '{{status}}',
      terms: '{{terms}}',
      notes: '{{notes}}',
      lines: [
        { sku: '{{lines[].sku}}', quantity: '{{lines[].quantity}}', amount: '{{lines[].amount}}' },
      ],
    });
  });

  it('gives an entity no UI materializer when no form creates it', () => {
    const account = entities.find((entity) => entity.entityName === 'Account');
    expect(account?.materializers).toEqual([]);
  });
});

describe('the contract', () => {
  it('writes rows that validate against packages/protocol', () => {
    for (const entity of entities) {
      for (const field of entity.fields) {
        if (field.derivedRule !== null)
          expect(() => DerivedRule.parse(field.derivedRule)).not.toThrow();
        if (field.distribution !== null) {
          const distribution = field.distribution as { shape: unknown };
          expect(() => DistributionShape.parse(distribution.shape)).not.toThrow();
        }
        expect(() => FieldValueConstraints.parse(field.valueConstraints)).not.toThrow();
        // The database's own invariant, restated here because it is the one that would let a
        // solver point a reference at nothing.
        expect(field.type === 'reference').toBe(field.referencesEntity !== null);
        expect(field.enumValues === null).toBe(field.type !== 'enum');
      }
      for (const materializer of entity.materializers) {
        expect(() => MaterializerSpec.parse(materializer.spec)).not.toThrow();
      }
    }
  });
});

describe('re-observing an entity that is already in memory', () => {
  it('never trades what it learned for what this pass happened to see', async () => {
    // A resumed crawl adopts its predecessor's memory version, so it re-walks *fewer* routes —
    // the ones already in the checkpoint are skipped outright. It therefore consolidates a
    // thinner picture of the same entity. What it must not do is write that thinner picture over
    // the richer one: a distribution replaced by null, or a required field made optional,
    // because this pass never loaded the page that said otherwise.
    const rich: EntitySchemaDraft = {
      entityName: 'Invoice',
      observedCount: 50,
      confidence: 0.9,
      fields: [
        {
          name: 'reference',
          type: 'string',
          required: true,
          derivedRule: null,
          enumValues: null,
          distribution: {
            shape: {
              kind: 'string_pattern',
              prefix: 'INV-',
              minLength: 8,
              maxLength: 8,
              charset: 'numeric',
            },
            sampleSize: 50,
            distinctCount: 50,
          },
          referencesEntity: null,
          valueConstraints: {
            min: null,
            max: null,
            minLength: null,
            maxLength: 8,
            pattern: 'INV-[0-9]{4}',
          },
          controlElementKey: 'invoices-new.create-invoice.reference',
          unique: true,
        },
      ],
      materializers: [
        {
          spec: { kind: 'ui', form: 'invoices-new.create-invoice', route: '/invoices/new' },
          priority: 2,
          verifiedAt: null,
          verificationTtlHours: 168,
        },
      ],
      deleteFlowElementKey: 'invoices.form.invoice-delete',
    };

    const richReference = rich.fields[0];
    if (richReference === undefined) throw new Error('unreachable');

    // The same entity as a pass that never reached the create form or the list endpoint sees it.
    const thin: EntitySchemaDraft = {
      ...rich,
      observedCount: 0,
      confidence: 0.2,
      fields: [
        {
          ...richReference,
          required: false,
          distribution: null,
          controlElementKey: null,
          unique: false,
          valueConstraints: {
            min: null,
            max: null,
            minLength: null,
            maxLength: null,
            pattern: null,
          },
        },
      ],
      materializers: [],
      deleteFlowElementKey: null,
    };

    const scoped = await createFixture(app.url);
    try {
      const version = await scoped.client.query<{ id: string }>(
        `INSERT INTO memory_versions (tenant_id, application_id, version, status)
         VALUES ($1, $2, 1, 'building') RETURNING id`,
        [scoped.tenantId, scoped.applicationId],
      );
      const memoryVersionId = version.rows[0]?.id;
      if (memoryVersionId === undefined) throw new Error('no memory version');

      const persist = async (schema: EntitySchemaDraft): Promise<void> => {
        await persistSchemas(
          (work) => database.withTenant(scoped.tenantId, work),
          { tenantId: scoped.tenantId, memoryVersionId },
          [schema],
        );
      };

      await persist(rich);
      await persist(thin);

      const [invoice] = await readSchemas(scoped.client, memoryVersionId);
      if (invoice === undefined) throw new Error('the Invoice schema was not written');

      const reference = invoice.fields.find((field) => field.name === 'reference');
      expect(reference?.required).toBe(true);
      expect(reference?.distribution).not.toBeNull();
      expect(reference?.controlElementKey).toBe('invoices-new.create-invoice.reference');
      expect(reference?.unique).toBe(true);
      expect(FieldValueConstraints.parse(reference?.valueConstraints).pattern).toBe('INV-[0-9]{4}');

      // Evidence only climbs: the version's knowledge is the union of both passes.
      expect(invoice.observedCount).toBe(50);
      expect(invoice.confidence).toBe(0.9);

      // And the materializer the thin pass never saw is still the way to create one.
      expect(invoice.materializers.map((materializer) => materializer.kind)).toEqual(['ui']);

      // Same rule for the delete flow: the thin pass never reached the screen holding it, and
      // must not erase it. An entity that silently lost its inverse operation would have the seed
      // preview start telling testers their records cannot be reverted.
      expect(invoice.deleteFlowElementKey).toBe('invoices.form.invoice-delete');
    } finally {
      await scoped.drop();
    }
  }, 60_000);
});

describe('PII', () => {
  it('persists no raw value observed in a response body', () => {
    // Everything written for every entity, as one string. If a customer name, a note, an email
    // or a line description survived anywhere in it, this finds it — whichever column it hid in.
    const persisted = JSON.stringify(entities);

    for (const sentinel of SENTINELS) {
      expect(persisted).not.toContain(sentinel);
    }

    // And the general case rather than the listed one: no customer name from any of the fifty
    // records, and no note, appears anywhere in what was stored.
    for (const record of app.state.orders) {
      expect(persisted).not.toContain(record.customer);
      expect(persisted).not.toContain(record.notes);
      for (const line of record.lines) expect(persisted).not.toContain(line.description);
    }
    for (const account of app.state.accounts) {
      expect(persisted).not.toContain(account.contactEmail);
    }
  });

  it('keeps values only where the contract stores a vocabulary', () => {
    // The one exception in `observers/pii.ts`: enum vocabularies are values, and they are the
    // only values. Every other retained string is a prefix short enough not to be one.
    const vocabularies = order.fields.flatMap((field) => (field.enumValues ?? []) as string[]);
    expect(vocabularies.length).toBeGreaterThan(0);
    for (const value of vocabularies) expect(value.length).toBeLessThanOrEqual(64);

    for (const field of order.fields) {
      if (field.distribution === null) continue;
      const shape = DistributionShape.parse((field.distribution as { shape: unknown }).shape);
      if (shape.kind !== 'string_pattern' || shape.prefix === null) continue;
      expect(shape.prefix.length).toBeLessThanOrEqual(8);
      expect(shape.prefix).not.toMatch(/\s/);
    }
  });

  it('leaves the application untouched, including its dry-run pricing endpoint', () => {
    // The observers added a POST to the traffic a crawl sees. It had better still be true that
    // nothing was created, deleted, approved or saved.
    expect(app.state.mutations).toEqual([]);
    expect(app.state.orders).toHaveLength(50);
  });
});
