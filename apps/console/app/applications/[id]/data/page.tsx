import { PendingScreen } from '../../../../src/components/pending-screen';

export const dynamic = 'force-dynamic';

/**
 * Data — learned entity schemas, materializer configuration, seeded records.
 */
export default async function DataPage() {
  return (
    <PendingScreen
      title="Data"
      from="GET /v1/schemas/:appId and the seed ledger for this application"
    />
  );
}
