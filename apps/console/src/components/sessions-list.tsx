import { formatUtc } from '../format';
import type { SessionList } from '../memory/schema';

/**
 * Session history for one application.
 *
 * Pagination is a query string so the list stays a Server Component. Detail is a separate
 * route that already loads the timeline.
 */
export function SessionsList({
  applicationId,
  listed,
  offset,
  limit,
}: {
  readonly applicationId: string;
  readonly listed: SessionList;
  readonly offset: number;
  readonly limit: number;
}) {
  const next = offset + limit;
  const prev = Math.max(0, offset - limit);

  return (
    <section className="card" aria-labelledby="sessions-heading">
      <h2 id="sessions-heading">Sessions</h2>
      <p className="hint">{listed.total} sittings recorded for this application.</p>
      <div className="scroll">
        <table>
          <caption>Newest first.</caption>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Ended</th>
              <th scope="col">Memory version</th>
              <th scope="col">Session</th>
            </tr>
          </thead>
          <tbody>
            {listed.sessions.length === 0 ? (
              <tr>
                <td colSpan={4} className="hint">
                  No sessions yet.
                </td>
              </tr>
            ) : (
              listed.sessions.map((sitting) => (
                <tr key={sitting.id}>
                  <td>{formatUtc(sitting.startedAt)}</td>
                  <td>{sitting.endedAt === null ? 'Open' : formatUtc(sitting.endedAt)}</td>
                  <td className="path">{sitting.memoryVersionId}</td>
                  <td className="path">
                    <a href={`/applications/${applicationId}/sessions/${sitting.id}`}>
                      {sitting.id}
                    </a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {listed.total > limit ? (
        <p className="decision-row">
          {offset === 0 ? null : (
            <a href={`/applications/${applicationId}/sessions?offset=${String(prev)}`}>Previous</a>
          )}
          {next >= listed.total ? null : (
            <a href={`/applications/${applicationId}/sessions?offset=${String(next)}`}>Next</a>
          )}
        </p>
      ) : null}
    </section>
  );
}
