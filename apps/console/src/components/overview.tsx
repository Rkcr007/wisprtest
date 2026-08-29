import type { ApplicationRecord } from '../applications/schema';
import { formatIndexAge, formatUtc } from '../format';
import type { SessionList } from '../memory/schema';

/**
 * Coverage chips, open drift, and the most recent sittings.
 *
 * Counts come from the active memory version. There is no coverage percentage: inventing one
 * would be the empty table this screen exists to replace.
 */
export function Overview({
  application,
  sessions,
}: {
  readonly application: ApplicationRecord;
  readonly sessions: SessionList;
}) {
  const indexed = application.memoryVersion !== null;

  return (
    <>
      <section className="card" aria-labelledby="overview-heading">
        <h2 id="overview-heading">Overview</h2>
        <p className="hint">
          {indexed
            ? `${application.name} is on memory version ${String(application.memoryVersion)}, indexed ${formatIndexAge(application.indexedAt)}.`
            : `${application.name} has not been indexed yet. Start an index from Connect.`}
        </p>
        <div className="chips">
          <span className={`chip ${indexed ? 'memory' : ''}`}>
            <span className="value">{indexed ? `v${String(application.memoryVersion)}` : '—'}</span>
            <span>memory</span>
          </span>
          <span className="chip">
            <span className="value">{application.screenCount}</span>
            <span>screens</span>
          </span>
          <span className="chip">
            <span className="value">{application.elementCount}</span>
            <span>elements</span>
          </span>
          <span className={`chip ${application.openDriftCount > 0 ? 'drift' : 'commit'}`}>
            <span className="value">{application.openDriftCount}</span>
            <span>open drift</span>
          </span>
        </div>
        <dl className="grid">
          <div>
            <dt className="hint">Environment</dt>
            <dd>{application.env}</dd>
          </div>
          <div>
            <dt className="hint">Base URL</dt>
            <dd className="path">{application.baseUrl}</dd>
          </div>
          <div>
            <dt className="hint">Indexed</dt>
            <dd>{application.indexedAt === null ? '—' : formatUtc(application.indexedAt)}</dd>
          </div>
        </dl>
        {application.openDriftCount > 0 ? (
          <p>
            <a href={`/applications/${application.id}/drift`}>Review open drift</a>
          </p>
        ) : null}
      </section>

      <section className="card" aria-labelledby="overview-sessions">
        <h2 id="overview-sessions">Recent sessions</h2>
        {sessions.sessions.length === 0 ? (
          <p className="hint">No sessions recorded for this application yet.</p>
        ) : (
          <table>
            <caption>Newest sittings first. {sessions.total} in total.</caption>
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">Status</th>
                <th scope="col">Session</th>
              </tr>
            </thead>
            <tbody>
              {sessions.sessions.map((sitting) => (
                <tr key={sitting.id}>
                  <td>{formatUtc(sitting.startedAt)}</td>
                  <td>{sitting.endedAt === null ? 'Open' : 'Closed'}</td>
                  <td className="path">
                    <a href={`/applications/${application.id}/sessions/${sitting.id}`}>
                      {sitting.id}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p>
          <a href={`/applications/${application.id}/sessions`}>All sessions</a>
        </p>
      </section>
    </>
  );
}
