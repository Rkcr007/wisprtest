import type { ApplicationOperationalMetric } from '../telemetry/metrics.js';
import { LIVE_DRIFT_STATUSES } from './drift-repository.js';
import type { UnscopedDatabase } from './pool.js';

/**
 * Read the fleet-level values behind the drift-backlog and memory-staleness gauges.
 *
 * This query intentionally runs through `TenantDatabase.unscoped('operational-metrics', ...)`.
 * A single process exports every tenant as a distinct bounded `(tenant_id, app_id)` series; no
 * value is returned through a product route. Reading from Postgres, rather than gateway events,
 * also captures crawl and reconcile transitions made by the indexer.
 */
export async function readApplicationOperationalMetrics(
  db: UnscopedDatabase,
  now: Date = new Date(),
): Promise<readonly ApplicationOperationalMetric[]> {
  const activeVersions = await db
    .selectFrom('memoryVersions')
    .select(['id', 'tenantId', 'applicationId'])
    .where('status', '=', 'active')
    .execute();

  if (activeVersions.length === 0) return [];

  const versionIds = activeVersions.map((version) => version.id);
  const [driftRows, screenRows] = await Promise.all([
    db
      .selectFrom('driftReports')
      .innerJoin('memoryVersions', 'memoryVersions.id', 'driftReports.memoryVersionId')
      .select(['memoryVersions.applicationId', (eb) => eb.fn.countAll<string>().as('openCount')])
      .where('driftReports.status', 'in', [...LIVE_DRIFT_STATUSES])
      .groupBy('memoryVersions.applicationId')
      .execute(),
    db
      .selectFrom('screens')
      .select(['memoryVersionId', (eb) => eb.fn.max<Date>('indexedAt').as('lastIndexedAt')])
      .where('memoryVersionId', 'in', versionIds)
      .groupBy('memoryVersionId')
      .execute(),
  ]);

  const driftByApplication = new Map(
    driftRows.map((row) => [row.applicationId, Number(row.openCount)]),
  );
  const indexedByVersion = new Map(
    screenRows.map((row) => [row.memoryVersionId, row.lastIndexedAt]),
  );

  return activeVersions
    .map((version) => {
      const lastIndexedAt = indexedByVersion.get(version.id);
      return {
        tenantId: version.tenantId,
        applicationId: version.applicationId,
        openDriftCount: driftByApplication.get(version.applicationId) ?? 0,
        memoryStalenessHours:
          lastIndexedAt === undefined
            ? null
            : Math.max(0, now.getTime() - lastIndexedAt.getTime()) / 3_600_000,
      };
    })
    .sort((left, right) => left.applicationId.localeCompare(right.applicationId));
}
