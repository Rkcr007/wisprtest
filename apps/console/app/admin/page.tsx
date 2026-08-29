import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { AdminAuditList, AdminPolicy, AdminUserList } from '../../src/admin/schema';
import { currentSession } from '../../src/auth/current';
import { AdminPanel } from '../../src/components/admin-panel';
import { ConsoleError } from '../../src/errors';
import { callGatewayJson } from '../../src/gateway/client';
import { isAuthRequired, pageLoadMessage } from '../../src/http/page-load';

export const dynamic = 'force-dynamic';

/**
 * Tenant administration — team, RBAC, frozen action/redaction policy, audit.
 *
 * Owner-only at the gateway. A lead landing here sees that sentence, not an empty matrix.
 */
export default function AdminPage() {
  return (
    <Suspense
      fallback={
        <section className="card" aria-busy="true">
          <h2>Admin</h2>
          <p className="visually-hidden" role="status">
            Loading administration
          </p>
        </section>
      }
    >
      <AdminLoaded />
    </Suspense>
  );
}

async function AdminLoaded() {
  const session = await currentSession();
  if (session === null) {
    redirect('/auth/login?next=%2Fadmin');
  }

  try {
    const [users, policy, audit] = await Promise.all([
      callGatewayJson(session, { method: 'GET', path: '/v1/admin/users' }, AdminUserList),
      callGatewayJson(session, { method: 'GET', path: '/v1/admin/policy' }, AdminPolicy),
      callGatewayJson(session, { method: 'GET', path: '/v1/admin/audit?limit=50' }, AdminAuditList),
    ]);
    return <AdminPanel users={users.users} policy={policy} audit={audit} />;
  } catch (error: unknown) {
    if (
      isAuthRequired(error) ||
      (error instanceof ConsoleError && error.code === 'auth_required')
    ) {
      redirect('/auth/login?next=%2Fadmin');
    }
    const forbidden = error instanceof ConsoleError && error.status === 403;
    return (
      <section className="card">
        <h2>Admin</h2>
        <p className="error" role="alert">
          {forbidden
            ? 'Administration is owner-only. A lead can index and approve drift; team and policy stay with the owner.'
            : pageLoadMessage(error, 'the console could not load administration')}
        </p>
      </section>
    );
  }
}
