import { PendingScreen } from '../../../../src/components/pending-screen';

export const dynamic = 'force-dynamic';

/**
 * Admin — team, RBAC matrix, action policy, redaction policy, audit log.
 *
 * The client does not hardcode that matrix. When the gateway exposes it, this screen will
 * render what the gateway returns.
 */
export default async function AdminPage() {
  return (
    <PendingScreen
      title="Admin"
      from="GET /v1/admin (team, RBAC, action policy, redaction policy, audit log)"
    />
  );
}
