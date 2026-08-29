import { PendingScreen } from '../../../../src/components/pending-screen';

export const dynamic = 'force-dynamic';

/**
 * Sessions list — history for this application.
 *
 * Session *detail* is a real screen at `./[sessionId]`. The list itself waits on a gateway
 * index of sessions for an application.
 */
export default async function SessionsListPage() {
  return (
    <PendingScreen
      title="Sessions"
      from="GET /v1/applications/:id/sessions (history). Open a sitting from that list to see its timeline."
    />
  );
}
