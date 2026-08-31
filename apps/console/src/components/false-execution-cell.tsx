'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import {
  FalseExecutionReport as FalseExecutionReportSchema,
  type FalseExecutionReason,
  type FalseExecutionReport,
} from 'protocol';
import { z } from 'zod';

import { ConsoleRouteError } from '../http/console-route-error';
import {
  REASONS,
  REASON_HINTS,
  REASON_LABELS,
  parseReport,
  parseWithdrawal,
  reportForStep,
  reportIssuesFromGateway,
  type ReportIssues,
} from '../sessions/false-execution';
import { SelectField, TextAreaField } from './field';

/**
 * The one place a tester can say "that step acted on the wrong thing".
 *
 * `CLAUDE.md` gates every release on a false execution rate under 0.1%, and until this cell
 * existed nothing in the product could produce the number. A false execution is not detectable
 * by the runtime — the resolver was confident and the dispatch succeeded — so the measurement
 * begins with a human saying so about a step they watched.
 *
 * ## One query, many cells
 *
 * Every cell in the table subscribes to the same key, seeded from the server render. That is one
 * fetch for the whole timeline, and a file or withdraw in any row invalidates it once so every
 * row re-renders from the same list. Per-cell state would let two rows disagree about a session
 * they are both describing.
 *
 * ## Nothing is hidden by role
 *
 * As on the drift queue: this screen does not inspect a role and does not hide the control. The
 * gateway decides who may file, and a refusal reaches the tester as the gateway's own sentence
 * rather than as a button that was never there.
 */

const REPORT_LIST = (sessionId: string): readonly [string, string] =>
  ['false-executions', sessionId] as const;

const ReportList = z.array(FalseExecutionReportSchema);

export function FalseExecutionCell({
  sessionId,
  stepOrdinal,
  initial,
}: {
  readonly sessionId: string;
  readonly stepOrdinal: number;
  readonly initial: readonly FalseExecutionReport[];
}) {
  const client = useQueryClient();
  const prefix = useId();
  const [filing, setFiling] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState<FalseExecutionReason | ''>('');
  const [note, setNote] = useState('');
  const [withdrawReason, setWithdrawReason] = useState('');
  const [issues, setIssues] = useState<ReportIssues>({});

  const listed = useQuery({
    queryKey: REPORT_LIST(sessionId),
    queryFn: async (): Promise<readonly FalseExecutionReport[]> => {
      const response = await fetch(`/api/sessions/${sessionId}/false-executions`);
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = ConsoleRouteError.safeParse(payload);
        throw new Error(failure.success ? failure.data.message : 'could not load the reports');
      }
      const parsed = ReportList.safeParse(payload);
      if (!parsed.success) throw new Error('the gateway returned an unrecognised report list');
      return parsed.data;
    },
    initialData: initial,
  });

  /** Shared by both mutations: a BFF refusal becomes field-level issues, not a generic banner. */
  const send = async (path: string, body: unknown): Promise<FalseExecutionReport> => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = ConsoleRouteError.safeParse(payload);
      if (failure.success) {
        setIssues((current) => ({
          ...current,
          ...reportIssuesFromGateway(failure.data.issues),
          form: current.form ?? failure.data.message,
        }));
        throw new Error(failure.data.message);
      }
      throw new Error(`the console could not reach the gateway (HTTP ${String(response.status)})`);
    }
    const parsed = FalseExecutionReportSchema.safeParse(payload);
    if (!parsed.success) throw new Error('the gateway returned an unrecognised report');
    return parsed.data;
  };

  const file = useMutation<FalseExecutionReport, Error, unknown>({
    mutationFn: (body) => send(`/api/sessions/${sessionId}/false-executions`, body),
    onSuccess: () => {
      setFiling(false);
      setReason('');
      setNote('');
      setIssues({});
      void client.invalidateQueries({ queryKey: REPORT_LIST(sessionId) });
    },
  });

  const withdraw = useMutation<FalseExecutionReport, Error, unknown>({
    mutationFn: (body) =>
      send(`/api/sessions/${sessionId}/false-executions/${String(stepOrdinal)}/withdraw`, body),
    onSuccess: () => {
      setWithdrawing(false);
      setWithdrawReason('');
      setIssues({});
      void client.invalidateQueries({ queryKey: REPORT_LIST(sessionId) });
    },
  });

  const report = reportForStep(listed.data, stepOrdinal);
  const busy = file.isPending || withdraw.isPending;

  const submitReport = (): void => {
    const parsed = parseReport({ stepOrdinal, reason, note });
    if (!parsed.ok) {
      setIssues(parsed.issues);
      return;
    }
    setIssues({});
    file.mutate(parsed.request);
  };

  const submitWithdrawal = (): void => {
    const parsed = parseWithdrawal(withdrawReason);
    if (!parsed.ok) {
      setIssues(parsed.issues);
      return;
    }
    setIssues({});
    withdraw.mutate(parsed.request);
  };

  const problem = issues.form ?? (file.isError ? file.error.message : null);

  // A withdrawn report is shown, not hidden. The gateway returns them deliberately: a list that
  // dropped them would make a retraction look like it never happened.
  if (report !== null && report.status === 'withdrawn') {
    return (
      <span className="hint">Withdrawn — was {REASON_LABELS[report.reason].toLowerCase()}</span>
    );
  }

  if (report !== null) {
    return (
      <div>
        <span className="status-open">{REASON_LABELS[report.reason]}</span>
        {report.note === null ? null : <p className="hint">{report.note}</p>}
        {withdrawing ? (
          <>
            <TextAreaField
              id={`${prefix}-withdraw`}
              label="Why withdraw?"
              rows={2}
              value={withdrawReason}
              onChange={setWithdrawReason}
              hint="This moves the number that gates a release."
              error={issues.reason}
            />
            <button type="button" disabled={busy} onClick={submitWithdrawal}>
              {withdraw.isPending ? 'Withdrawing…' : 'Confirm withdrawal'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setWithdrawing(false);
                setIssues({});
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setWithdrawing(true);
            }}
          >
            Withdraw
          </button>
        )}
        {withdraw.isError && issues.form === undefined ? (
          <p className="error" role="alert">
            {withdraw.error.message}
          </p>
        ) : null}
        {issues.form === undefined ? null : (
          <p className="error" role="alert">
            {issues.form}
          </p>
        )}
      </div>
    );
  }

  if (!filing) {
    return (
      <button
        type="button"
        onClick={() => {
          setFiling(true);
        }}
      >
        Report
      </button>
    );
  }

  return (
    <div>
      <SelectField<FalseExecutionReason | ''>
        id={`${prefix}-reason`}
        label="What went wrong?"
        value={reason}
        onChange={setReason}
        options={[
          { value: '', label: 'Choose…' },
          ...REASONS.map((value) => ({ value, label: REASON_LABELS[value] })),
        ]}
        hint={reason === '' ? 'They are fixed in different places.' : REASON_HINTS[reason]}
        error={issues.reason}
      />
      <TextAreaField
        id={`${prefix}-note`}
        label="Note (optional)"
        rows={2}
        value={note}
        onChange={setNote}
        hint="Redacted before it is stored. Do not paste customer data."
        error={issues.note}
      />
      <button type="button" disabled={busy} onClick={submitReport}>
        {file.isPending ? 'Reporting…' : 'File report'}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setFiling(false);
          setIssues({});
        }}
      >
        Cancel
      </button>
      {problem === null ? null : (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
