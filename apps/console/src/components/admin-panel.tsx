'use client';

import { useState } from 'react';

import type { AdminAuditList, AdminPolicy, AdminUser } from '../admin/schema';
import { formatUtc } from '../format';

const ROLES = ['viewer', 'tester', 'lead', 'owner'] as const;

/**
 * Team, the frozen RBAC / reversibility / redaction policy, and the audit log.
 *
 * Role changes go through the BFF. The policy table is not a form: flipping Class C to
 * speculative is the worst bug this product can ship, so the gateway refuses writes and this
 * screen does not offer any.
 */
export function AdminPanel({
  users,
  policy,
  audit,
}: {
  readonly users: readonly AdminUser[];
  readonly policy: AdminPolicy;
  readonly audit: AdminAuditList;
}) {
  return (
    <>
      <section className="card" aria-labelledby="admin-team">
        <h2 id="admin-team">Team</h2>
        <div className="scroll">
          <table>
            <caption>Users in this tenant.</caption>
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.email}</td>
                  <td>
                    <RoleSelect user={user} />
                  </td>
                  <td>{formatUtc(user.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="admin-rbac">
        <h2 id="admin-rbac">RBAC matrix</h2>
        <p className="hint">Read-only. Roles are cumulative; admin:manage is owner-only.</p>
        <div className="scroll">
          <table>
            <caption>Permissions held by each role.</caption>
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Permissions</th>
              </tr>
            </thead>
            <tbody>
              {policy.roles.map((role) => (
                <tr key={role}>
                  <td>{role}</td>
                  <td className="path">{(policy.permissionsByRole[role] ?? []).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="admin-policy">
        <h2 id="admin-policy">Action and redaction policy</h2>
        <p className="hint">
          Not writable. Speculating on Class C is the single worst bug this product can have.
        </p>
        <table>
          <caption>Reversibility taxonomy.</caption>
          <thead>
            <tr>
              <th scope="col">Class</th>
              <th scope="col">Meaning</th>
              <th scope="col">Speculative</th>
              <th scope="col">Confirmation</th>
            </tr>
          </thead>
          <tbody>
            {policy.reversibility.map((row) => (
              <tr key={row.class}>
                <td>{row.class}</td>
                <td>{row.meaning}</td>
                <td>{row.speculative ? 'yes' : 'never'}</td>
                <td>{row.confirmation ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">
          Redaction stores {policy.redaction.stores}. Masks: {policy.redaction.masks.join(', ')}.
          Element text in logs: no. Customer data in model prompts: no.
        </p>
      </section>

      <section className="card" aria-labelledby="admin-audit">
        <h2 id="admin-audit">Audit log</h2>
        <div className="scroll">
          <table>
            <caption>{String(audit.total)} entries, newest first.</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Target</th>
              </tr>
            </thead>
            <tbody>
              {audit.entries.length === 0 ? (
                <tr>
                  <td colSpan={4} className="hint">
                    No audit rows yet.
                  </td>
                </tr>
              ) : (
                audit.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatUtc(entry.createdAt)}</td>
                    <td className="path">{entry.actor}</td>
                    <td>{entry.action}</td>
                    <td className="path">{entry.target}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function RoleSelect({ user }: { readonly user: AdminUser }) {
  const [role, setRole] = useState(user.role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <span>
      <label className="visually-hidden" htmlFor={`role-${user.id}`}>
        Role for {user.email}
      </label>
      <select
        id={`role-${user.id}`}
        value={role}
        disabled={busy}
        onChange={(event) => {
          const next = event.target.value;
          if (next === role) return;
          void (async () => {
            setBusy(true);
            setError(null);
            const response = await fetch(`/api/admin/users/${user.id}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ role: next }),
            });
            const payload: unknown = await response.json().catch(() => null);
            setBusy(false);
            if (!response.ok) {
              const message =
                payload !== null &&
                typeof payload === 'object' &&
                'message' in payload &&
                typeof payload.message === 'string'
                  ? payload.message
                  : 'the console could not change that role';
              setError(message);
              return;
            }
            if (next === 'viewer' || next === 'tester' || next === 'lead' || next === 'owner') {
              setRole(next);
            }
          })();
        }}
      >
        {ROLES.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      {error === null ? null : (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
