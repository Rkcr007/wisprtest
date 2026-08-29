'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import {
  DriftDecisionResponse,
  DriftListResponse as DriftListResponseSchema,
  type DriftDecisionRequest,
  type DriftDecisionResponse as DecisionOutcome,
  type DriftListResponse,
  type DriftReport,
  type StructuralDiff,
} from 'protocol';

import {
  decisionIssuesFromGateway,
  parseDriftDecision,
  removeReport,
  type DriftDecisionIssues,
} from '../drift/decision';
import { formatRate, formatUtc } from '../format';
import { ConsoleRouteError } from '../http/console-route-error';
import { TextAreaField } from './field';

const DRIFT_LIST = (applicationId: string): readonly [string, string] =>
  ['drift-reports', applicationId] as const;

/**
 * Pending drift reports, with approve/reject that update the queue before the response lands.
 *
 * The list is server-rendered into `initial` and then owned by TanStack Query so a decision can
 * drop the row immediately and put it back if the gateway refuses. The gateway still decides
 * whether the caller may approve — this screen does not inspect a role, and it does not hide
 * Approve on an `open` report. A refusal is the gateway's sentence, announced, not a missing
 * button.
 */
export function DriftQueue({
  applicationId,
  initial,
}: {
  readonly applicationId: string;
  readonly initial: DriftListResponse;
}) {
  const client = useQueryClient();
  const prefix = useId();
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [issues, setIssues] = useState<DriftDecisionIssues>({});

  const listed = useQuery({
    queryKey: DRIFT_LIST(applicationId),
    queryFn: async (): Promise<DriftListResponse> => {
      const response = await fetch(`/api/applications/${applicationId}/drift`);
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = ConsoleRouteError.safeParse(payload);
        throw new Error(failure.success ? failure.data.message : 'could not load drift reports');
      }
      const parsed = DriftListResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error('the gateway returned an unrecognised drift list');
      return parsed.data;
    },
    initialData: initial,
  });

  const decide = useMutation<
    DecisionOutcome,
    Error,
    { reportId: string; request: DriftDecisionRequest },
    { previous: DriftListResponse | undefined }
  >({
    mutationFn: async ({ reportId, request }) => {
      const response = await fetch(`/api/drift/${reportId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = ConsoleRouteError.safeParse(payload);
        if (failure.success) {
          setIssues((current) => ({
            ...current,
            ...decisionIssuesFromGateway(failure.data.issues),
            form: current.form ?? failure.data.message,
          }));
          throw new Error(failure.data.message);
        }
        throw new Error(
          `the console could not record the decision (HTTP ${String(response.status)})`,
        );
      }
      const parsed = DriftDecisionResponse.safeParse(payload);
      if (!parsed.success) throw new Error('the gateway returned an unrecognised decision');
      return parsed.data;
    },

    onMutate: async ({ reportId }) => {
      await client.cancelQueries({ queryKey: DRIFT_LIST(applicationId) });
      const previous = client.getQueryData<DriftListResponse>(DRIFT_LIST(applicationId));
      if (previous !== undefined) {
        client.setQueryData(DRIFT_LIST(applicationId), removeReport(previous, reportId));
      }
      return { previous };
    },

    onError: (_error, _variables, context) => {
      if (context?.previous !== undefined) {
        client.setQueryData(DRIFT_LIST(applicationId), context.previous);
      }
    },

    onSuccess: () => {
      setRejectingId(null);
      setReason('');
      setIssues({});
    },
  });

  const submit = (reportId: string, decision: 'approve' | 'reject'): void => {
    const parsed = parseDriftDecision({
      decision,
      reason: decision === 'reject' ? reason : '',
    });
    if (!parsed.ok) {
      setIssues(parsed.issues);
      return;
    }
    setIssues({});
    decide.mutate({ reportId, request: parsed.request });
  };

  const reports = listed.data.reports;
  const busy = decide.isPending;

  return (
    <section className="card" aria-labelledby={`${prefix}-heading`}>
      <h2 id={`${prefix}-heading`}>Drift</h2>
      <p className="hint">
        Pending reports. Approving activates the candidate memory version the indexer built.
        Rejecting leaves memory as it is. The gateway refuses a decision the caller is not allowed
        to make; this screen does not guess that in advance.
      </p>

      <div className="chips">
        <span className="chip drift">
          <span className="value">{listed.data.total}</span>
          <span>pending</span>
        </span>
        <span className="chip">
          <span className="value">{reports.length}</span>
          <span>on this page</span>
        </span>
      </div>

      {listed.isError ? (
        <p className="error" role="alert">
          {listed.error.message}
        </p>
      ) : null}
      {issues.form === undefined ? null : (
        <p className="error" role="alert">
          {issues.form}
        </p>
      )}
      {decide.isError && issues.form === undefined ? (
        <p className="error" role="alert">
          {decide.error.message}
        </p>
      ) : null}

      <div className="scroll">
        <table>
          <caption>Pending reports, newest first.</caption>
          <thead>
            <tr>
              <th scope="col">Route</th>
              <th scope="col">Status</th>
              <th scope="col">Alias survival</th>
              <th scope="col">Detected</th>
              <th scope="col">Raised</th>
              <th scope="col">Review</th>
            </tr>
          </thead>
          <tbody>
            {reports.length === 0 ? (
              <tr>
                <td colSpan={6} className="hint">
                  No pending reports. A structural mismatch raised by the extension or a scheduled
                  re-crawl will appear here once the gateway has one to show.
                </td>
              </tr>
            ) : (
              reports.map((report) => (
                <ReportRow
                  key={report.id}
                  report={report}
                  prefix={prefix}
                  rejecting={rejectingId === report.id}
                  reason={rejectingId === report.id ? reason : ''}
                  reasonError={rejectingId === report.id ? issues.reason : undefined}
                  busy={busy}
                  onApprove={() => {
                    submit(report.id, 'approve');
                  }}
                  onBeginReject={() => {
                    setRejectingId(report.id);
                    setReason('');
                    setIssues({});
                  }}
                  onReasonChange={setReason}
                  onConfirmReject={() => {
                    submit(report.id, 'reject');
                  }}
                  onCancelReject={() => {
                    setRejectingId(null);
                    setReason('');
                    setIssues({});
                  }}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReportRow({
  report,
  prefix,
  rejecting,
  reason,
  reasonError,
  busy,
  onApprove,
  onBeginReject,
  onReasonChange,
  onConfirmReject,
  onCancelReject,
}: {
  readonly report: DriftReport;
  readonly prefix: string;
  readonly rejecting: boolean;
  readonly reason: string;
  readonly reasonError: string | undefined;
  readonly busy: boolean;
  readonly onApprove: () => void;
  readonly onBeginReject: () => void;
  readonly onReasonChange: (value: string) => void;
  readonly onConfirmReject: () => void;
  readonly onCancelReject: () => void;
}) {
  const reasonId = `${prefix}-reason-${report.id}`;

  return (
    <tr>
      <td>
        <div className="path">{report.routePattern}</div>
        <div className="hint">{report.observedRoute}</div>
        <DiffReview report={report} />
      </td>
      <td className={`status-${report.status}`}>{report.status}</td>
      <td className="numeric">
        {report.aliasMigrationRate === null ? '—' : formatRate(report.aliasMigrationRate)}
      </td>
      <td>{report.detectedBy}</td>
      <td>{formatUtc(report.createdAt)}</td>
      <td>
        <div className="decision-row">
          <button type="button" className="primary" disabled={busy} onClick={onApprove}>
            Approve
          </button>
          {rejecting ? null : (
            <button type="button" disabled={busy} onClick={onBeginReject}>
              Reject
            </button>
          )}
        </div>
        {rejecting ? (
          <div className="reject-form">
            <TextAreaField
              id={reasonId}
              label="Reason"
              value={reason}
              error={reasonError}
              hint="Required. The next reviewer reads this when the same screen drifts again."
              onChange={onReasonChange}
            />
            <div className="decision-row">
              <button type="button" disabled={busy} onClick={onConfirmReject}>
                Confirm reject
              </button>
              <button type="button" disabled={busy} onClick={onCancelReject}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function DiffReview({ report }: { readonly report: DriftReport }) {
  if (report.diff === null) {
    return (
      <p className="hint">
        No reviewable diff yet
        {report.status === 'reconciling'
          ? ' — the indexer is still reconciling this screen.'
          : '.'}{' '}
        Approving is refused until a candidate version exists.
      </p>
    );
  }

  return (
    <details>
      <summary>Reviewable diff</summary>
      <DiffLists diff={report.diff} />
    </details>
  );
}

function DiffLists({ diff }: { readonly diff: StructuralDiff }) {
  return (
    <div className="diff-review">
      <DiffGroup
        title="Added"
        empty="None."
        items={diff.added.map(
          (item) => `${item.elementKey} · ${item.role} · ${item.accessibleNameRedacted}`,
        )}
      />
      <DiffGroup
        title="Removed"
        empty="None."
        items={diff.removed.map((item) => `${item.elementKey} · ${item.role}`)}
      />
      <DiffGroup
        title="Moved"
        empty="None."
        items={diff.moved.map(
          (item) =>
            `${item.elementKey} · ${item.fromLandmarkPath.join(' / ') || '—'} → ${item.toLandmarkPath.join(' / ') || '—'}`,
        )}
      />
      <DiffGroup
        title="Renamed"
        empty="None."
        items={diff.renamed.map((item) => `${item.elementKey} · now ${item.toNameRedacted}`)}
      />
      <DiffGroup
        title="Schema"
        empty="None."
        items={diff.schemaChanges.map((item) => `${item.entity}: ${item.detail}`)}
      />
    </div>
  );
}

function DiffGroup({
  title,
  empty,
  items,
}: {
  readonly title: string;
  readonly empty: string;
  readonly items: readonly string[];
}) {
  return (
    <div>
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="hint">{empty}</p>
      ) : (
        <ul className="diff-list">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
