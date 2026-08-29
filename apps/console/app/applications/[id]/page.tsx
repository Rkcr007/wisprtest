import { PendingScreen } from '../../../src/components/pending-screen';

export const dynamic = 'force-dynamic';

/**
 * Application overview — coverage, drift status, recent sessions.
 *
 * Those reads are not on a gateway route the console can call yet, so this page is the nav
 * destination and says so. Coverage numbers are not invented.
 */
export default async function OverviewPage() {
  return (
    <PendingScreen
      title="Overview"
      from="GET /v1/applications/:id (coverage, drift status, recent sessions)"
    />
  );
}
