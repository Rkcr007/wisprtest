import { DriftDecisionRequest, type DriftListResponse, type DriftReport } from 'protocol';

/**
 * A human's decision on a pending drift report, parsed the way the Connect form parses bounds:
 * locally, against the contract, before a request leaves the browser.
 *
 * The gateway still enforces `drift:approve` and the report lifecycle. This module does not
 * know roles, and it does not hide Approve because a report is still `open` — those refusals
 * belong to the gateway and must reach the tester as the gateway's own sentence.
 */

export interface DriftDecisionValues {
  readonly decision: 'approve' | 'reject';
  readonly reason: string;
}

export type DriftDecisionField = 'reason' | 'form';

export type DriftDecisionIssues = Partial<Record<DriftDecisionField, string>>;

export type DriftDecisionResult =
  | { readonly ok: true; readonly request: DriftDecisionRequest }
  | { readonly ok: false; readonly issues: DriftDecisionIssues };

/**
 * Turn the on-screen decision into a contract-valid `DriftDecisionRequest`.
 *
 * An approval carries no reason: the diff is the explanation and it is already stored. A
 * rejection without a reason is refused here — the contract requires one, and a lead who
 * discards a proposal the indexer believed in owes the next reviewer the why.
 */
export function parseDriftDecision(values: DriftDecisionValues): DriftDecisionResult {
  if (values.decision === 'approve') {
    return { ok: true, request: { decision: 'approve' } };
  }

  const reason = values.reason.trim();
  if (reason.length === 0) {
    return {
      ok: false,
      issues: {
        reason: 'A rejection names why, so the next reviewer is not guessing.',
      },
    };
  }

  const parsed = DriftDecisionRequest.safeParse({ decision: 'reject', reason });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      issues: { reason: first === undefined ? 'the rejection is incomplete' : first.message },
    };
  }

  return { ok: true, request: parsed.data };
}

/**
 * A gateway `validation_failed` mapped onto the reject form.
 *
 * The gateway names `reason` when the body is a rejection it will not accept, and `id` when the
 * report itself cannot be decided (already resolved, not yet reconciled). Those belong on the
 * form-level slot, not silently dropped.
 */
export function decisionIssuesFromGateway(
  gatewayIssues: readonly { readonly path: string; readonly message: string }[],
): DriftDecisionIssues {
  const issues: DriftDecisionIssues = {};

  for (const issue of gatewayIssues) {
    const head = issue.path.split('.')[0] ?? '';
    if (head === 'reason') {
      issues.reason ??= issue.message;
    } else {
      issues.form ??= issue.message;
    }
  }

  return issues;
}

/**
 * The list after one report has been decided.
 *
 * Used as the optimistic update: the row leaves the queue the moment the request leaves, and
 * `onError` puts the previous list back. `total` shrinks by the number of rows actually removed
 * so a page that was showing "3 of 40" cannot claim 40 after the row is gone.
 */
export function removeReport(list: DriftListResponse, reportId: string): DriftListResponse {
  const reports = list.reports.filter((report) => report.id !== reportId);
  const removed = list.reports.length - reports.length;
  return {
    reports,
    total: Math.max(0, list.total - removed),
  };
}

/** Whether this report still belongs on the pending queue. */
export function isPendingReport(report: DriftReport): boolean {
  return report.status === 'open' || report.status === 'reconciling' || report.status === 'diffed';
}
