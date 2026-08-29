import type { ScopedDatabase } from '../db/pool.js';
import { LIVE_DRIFT_STATUSES } from '../db/drift-repository.js';

/**
 * Live aggregates the Connect and Overview screens need.
 *
 * Counts come from the active memory version. There is no coverage score: inventing one would
 * be the empty table these fields exist to replace. An application that has never been indexed
 * answers with nulls and zeros.
 */

export interface ApplicationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly env: string;
  readonly createdAt: string;
  readonly memoryVersion: number | null;
  readonly memoryVersionId: string | null;
  readonly indexedAt: string | null;
  readonly screenCount: number;
  readonly elementCount: number;
  readonly openDriftCount: number;
}

export async function enrichApplications(
  db: ScopedDatabase,
  rows: readonly {
    readonly id: string;
    readonly tenantId: string;
    readonly name: string;
    readonly baseUrl: string;
    readonly env: string;
    readonly createdAt: Date;
  }[],
): Promise<ApplicationRecord[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const versions = await db
    .selectFrom('memoryVersions')
    .select(['id', 'applicationId', 'version', 'createdAt'])
    .where('applicationId', 'in', ids)
    .where('status', '=', 'active')
    .execute();
  const versionByApp = new Map(versions.map((row) => [row.applicationId, row]));
  const versionIds = versions.map((row) => row.id);

  const screenCounts = new Map<string, number>();
  const elementCounts = new Map<string, number>();
  const driftCounts = new Map<string, number>();

  if (versionIds.length > 0) {
    const screens = await db
      .selectFrom('screens')
      .select(['memoryVersionId', (eb) => eb.fn.countAll<string>().as('n')])
      .where('memoryVersionId', 'in', versionIds)
      .groupBy('memoryVersionId')
      .execute();
    for (const row of screens) screenCounts.set(row.memoryVersionId, Number(row.n));

    const elements = await db
      .selectFrom('elements')
      .innerJoin('screens', 'screens.id', 'elements.screenId')
      .select(['screens.memoryVersionId', (eb) => eb.fn.countAll<string>().as('n')])
      .where('screens.memoryVersionId', 'in', versionIds)
      .groupBy('screens.memoryVersionId')
      .execute();
    for (const row of elements) elementCounts.set(row.memoryVersionId, Number(row.n));
  }

  const drifts = await db
    .selectFrom('driftReports')
    .innerJoin('memoryVersions', 'memoryVersions.id', 'driftReports.memoryVersionId')
    .select(['memoryVersions.applicationId', (eb) => eb.fn.countAll<string>().as('n')])
    .where('memoryVersions.applicationId', 'in', ids)
    .where('driftReports.status', 'in', [...LIVE_DRIFT_STATUSES])
    .groupBy('memoryVersions.applicationId')
    .execute();
  for (const row of drifts) driftCounts.set(row.applicationId, Number(row.n));

  return rows.map((row) => {
    const version = versionByApp.get(row.id);
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      baseUrl: row.baseUrl,
      env: row.env,
      createdAt: row.createdAt.toISOString(),
      memoryVersion: version?.version ?? null,
      memoryVersionId: version?.id ?? null,
      indexedAt: version === undefined ? null : version.createdAt.toISOString(),
      screenCount: version === undefined ? 0 : (screenCounts.get(version.id) ?? 0),
      elementCount: version === undefined ? 0 : (elementCounts.get(version.id) ?? 0),
      openDriftCount: driftCounts.get(row.id) ?? 0,
    };
  });
}
