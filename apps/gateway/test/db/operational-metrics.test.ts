import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { readApplicationOperationalMetrics } from '../../src/db/operational-metrics-repository.js';
import { createTenantDatabase, type TenantDatabase } from '../../src/db/pool.js';
import { CONTOSO, NORTHWIND } from './support.js';

let database: TenantDatabase;

beforeAll(() => {
  database = createTenantDatabase(loadConfig());
});

afterAll(async () => {
  await database.close();
});

describe('readApplicationOperationalMetrics', () => {
  it('reads every active application as a separately labelled fleet metric', async () => {
    const now = new Date('2026-08-30T00:00:00.000Z');
    await database.unscoped('operational-metrics', async (db) => {
      await db
        .updateTable('memoryVersions')
        .set({ status: 'active' })
        .where('id', '=', CONTOSO.memoryVersionId)
        .execute();
    });

    try {
      const values = await database.unscoped('operational-metrics', (db) =>
        readApplicationOperationalMetrics(db, now),
      );
      const northwind = values.find((value) => value.applicationId === NORTHWIND.applicationId);
      const contoso = values.find((value) => value.applicationId === CONTOSO.applicationId);

      expect(northwind).toMatchObject({
        tenantId: NORTHWIND.tenantId,
        applicationId: NORTHWIND.applicationId,
      });
      expect(contoso).toEqual({
        tenantId: CONTOSO.tenantId,
        applicationId: CONTOSO.applicationId,
        openDriftCount: 0,
        memoryStalenessHours: null,
      });
      expect(northwind?.openDriftCount).toBeGreaterThanOrEqual(0);
      expect(northwind?.memoryStalenessHours).toBeGreaterThanOrEqual(0);
    } finally {
      await database.unscoped('operational-metrics', async (db) => {
        await db
          .updateTable('memoryVersions')
          .set({ status: 'building' })
          .where('id', '=', CONTOSO.memoryVersionId)
          .execute();
      });
    }
  });
});
