import type { SessionStep, SessionTimeline as Timeline, SignedEvidence } from 'protocol';

import { formatLatencyMs, formatUtc } from '../format';
import { signedEvidenceFor } from '../sessions/evidence';

/**
 * One session: identity, the ordered step timeline, and signed evidence links.
 *
 * A Server Component. The bytes never sit in this process — each evidence cell is a link the
 * gateway signed, or an honest "not signed" when a step names a key the timeline did not
 * resolve. A missing URL is not guessed.
 */
export function SessionTimelineView({ timeline }: { readonly timeline: Timeline }) {
  const { session, steps, evidence } = timeline;
  const open = session.endedAt === null;

  return (
    <>
      <section className="card" aria-labelledby="session-heading">
        <h2 id="session-heading">Session</h2>
        <p className="hint">
          {open
            ? 'This session is still open. Steps continue to land until it is closed.'
            : `Closed ${formatUtc(session.endedAt ?? session.startedAt)}. Closed is terminal.`}
        </p>
        <div className="chips">
          <span className={`chip ${open ? 'signal' : 'commit'}`}>
            <span className="value">{open ? 'Open' : 'Closed'}</span>
            <span>status</span>
          </span>
          <span className="chip">
            <span className="value">{steps.length}</span>
            <span>steps</span>
          </span>
          <span className="chip memory">
            <span className="value">{evidence.length}</span>
            <span>signed artifacts</span>
          </span>
        </div>
        <dl className="grid">
          <Detail label="Started" value={formatUtc(session.startedAt)} />
          <Detail
            label="Ended"
            value={session.endedAt === null ? '—' : formatUtc(session.endedAt)}
          />
          <Detail label="Memory version" value={session.memoryVersionId} />
          <Detail label="Session" value={session.id} />
        </dl>
      </section>

      <section className="card" aria-labelledby="session-steps">
        <h2 id="session-steps">Timeline</h2>
        <div className="scroll">
          <table>
            <caption>Recorded steps, in ordinal order.</caption>
            <thead>
              <tr>
                <th scope="col" className="numeric">
                  #
                </th>
                <th scope="col">Utterance</th>
                <th scope="col">Tier</th>
                <th scope="col">Class</th>
                <th scope="col">Outcome</th>
                <th scope="col" className="numeric">
                  Latency
                </th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {steps.length === 0 ? (
                <tr>
                  <td colSpan={7} className="hint">
                    No steps recorded yet.
                  </td>
                </tr>
              ) : (
                steps.map((step) => <StepRow key={step.id} step={step} evidence={evidence} />)
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function StepRow({
  step,
  evidence,
}: {
  readonly step: SessionStep;
  readonly evidence: readonly SignedEvidence[];
}) {
  return (
    <tr>
      <td className="numeric">{step.ordinal}</td>
      <td>{step.utterance}</td>
      <td>{step.tier ?? '—'}</td>
      <td>{step.actionClass ?? '—'}</td>
      <td>{step.outcome}</td>
      <td className="numeric">{formatLatencyMs(step.latencyMs)}</td>
      <td>
        <EvidenceLinks refs={step.evidence} signed={evidence} />
      </td>
    </tr>
  );
}

function EvidenceLinks({
  refs,
  signed,
}: {
  readonly refs: SessionStep['evidence'];
  readonly signed: readonly SignedEvidence[];
}) {
  if (refs.length === 0) return <span className="hint">—</span>;

  return (
    <ul className="evidence-list">
      {refs.map((ref) => {
        const resolved = signedEvidenceFor(signed, ref.storageKey);
        const label = ref.kind === 'screenshot' ? 'Screenshot' : 'DOM snapshot';
        if (resolved === null) {
          return (
            <li key={ref.storageKey}>
              <span className="hint">
                {label} — not signed; the gateway did not issue a URL for this key.
              </span>
            </li>
          );
        }
        return (
          <li key={ref.storageKey}>
            <a href={resolved.url} rel="noopener noreferrer" target="_blank">
              {label}
            </a>
            <span className="hint"> expires {formatUtc(resolved.expiresAt)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="field">
      <dt>
        <label>{label}</label>
      </dt>
      <dd className="path detail-value">{value}</dd>
    </div>
  );
}
