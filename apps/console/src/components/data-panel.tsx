import type { EntitySchema, SeedLedgerEntry } from 'protocol';

import { formatUtc } from '../format';
import { LedgerRevert } from './ledger-revert';

/**
 * Learned schemas and the seed ledger for one session.
 *
 * Field specs expand in place. Revert is a lead action and goes through the console BFF so the
 * browser never holds the OIDC token.
 */
export function DataPanel({
  applicationId,
  schemas,
  memoryVersionId,
  sessionId,
  entries,
}: {
  readonly applicationId: string;
  readonly schemas: readonly EntitySchema[];
  readonly memoryVersionId: string | null;
  readonly sessionId: string | null;
  readonly entries: readonly SeedLedgerEntry[];
}) {
  return (
    <>
      <section className="card" aria-labelledby="data-schemas">
        <h2 id="data-schemas">Entity schemas</h2>
        <p className="hint">
          {memoryVersionId === null
            ? 'No active memory version, so there are no learned schemas.'
            : `${String(schemas.length)} entities inferred for the active version.`}
        </p>
        {schemas.length === 0 ? null : (
          <div className="scroll">
            {schemas.map((schema) => (
              <details key={schema.id}>
                <summary>
                  {schema.entityName} · {schema.fields.length} fields · {schema.observedCount}{' '}
                  observed
                </summary>
                <table>
                  <caption>Field specs for {schema.entityName}.</caption>
                  <thead>
                    <tr>
                      <th scope="col">Field</th>
                      <th scope="col">Type</th>
                      <th scope="col">Required</th>
                      <th scope="col">Unique</th>
                      <th scope="col">Derived</th>
                      <th scope="col">Enum</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schema.fields.map((field) => (
                      <tr key={field.id}>
                        <td className="path">{field.name}</td>
                        <td>{field.type}</td>
                        <td>{field.required ? 'yes' : 'no'}</td>
                        <td>{field.unique ? 'yes' : 'no'}</td>
                        <td>{field.derivedRule === null ? '—' : 'yes'}</td>
                        <td>{field.enumValues === null ? '—' : field.enumValues.join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h3>Materializers</h3>
                {schema.materializers.length === 0 ? (
                  <p className="hint">None learned.</p>
                ) : (
                  <ul className="diff-list">
                    {schema.materializers.map((materializer) => (
                      <li key={materializer.id}>
                        priority {materializer.priority}
                        {materializer.verifiedAt === null
                          ? ' · unverified'
                          : ` · verified ${formatUtc(materializer.verifiedAt)}`}
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            ))}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="data-ledger">
        <h2 id="data-ledger">Seeded records</h2>
        {sessionId === null ? (
          <p className="hint">
            No sessions for this application, so there is no ledger to show.{' '}
            <a href={`/applications/${applicationId}/sessions`}>Open sessions</a>
          </p>
        ) : (
          <>
            <p className="hint">
              Ledger for{' '}
              <a href={`/applications/${applicationId}/sessions/${sessionId}`}>{sessionId}</a>.
              Revert is Class S: it writes to the application under test and never speculates.
            </p>
            <div className="scroll">
              <table>
                <caption>Seed ledger, newest first.</caption>
                <thead>
                  <tr>
                    <th scope="col">Entity</th>
                    <th scope="col">Ref</th>
                    <th scope="col">Adapter</th>
                    <th scope="col">Created</th>
                    <th scope="col">Reverted</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="hint">
                        This session has not seeded anything.
                      </td>
                    </tr>
                  ) : (
                    entries.map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.entity}</td>
                        <td className="path">{entry.externalRef}</td>
                        <td>{entry.adapterUsed}</td>
                        <td>{formatUtc(entry.createdAt)}</td>
                        <td>{entry.revertedAt === null ? '—' : formatUtc(entry.revertedAt)}</td>
                        <td>
                          {entry.revertedAt === null ? (
                            <LedgerRevert ledgerEntryId={entry.id} />
                          ) : (
                            'reverted'
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </>
  );
}
