import { DriftDecisionRequest, DriftListResponse, DriftReport } from 'protocol';
import { describe, expect, it } from 'vitest';

import {
  decisionIssuesFromGateway,
  isPendingReport,
  parseDriftDecision,
  removeReport,
} from './decision';
import { DIFFED_REPORT, DRIFT_LIST, OPEN_REPORT } from './fixtures';

describe('parseDriftDecision', () => {
  it('accepts an approval with no reason — the diff is the explanation', () => {
    const result = parseDriftDecision({ decision: 'approve', reason: '' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).toEqual({ decision: 'approve' });
    expect(DriftDecisionRequest.safeParse(result.request).success).toBe(true);
  });

  it('ignores a leftover reason when the decision is approve', () => {
    const result = parseDriftDecision({ decision: 'approve', reason: 'should not travel' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).toEqual({ decision: 'approve' });
    expect(JSON.stringify(result.request)).not.toContain('should not travel');
  });

  it('refuses a rejection with no reason, on that field', () => {
    const result = parseDriftDecision({ decision: 'reject', reason: '' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.reason).toContain('names why');
  });

  it('refuses a rejection that is only whitespace', () => {
    const result = parseDriftDecision({ decision: 'reject', reason: '   \n  ' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.reason).toBeDefined();
  });

  it('trims the reason and produces a contract-valid rejection', () => {
    const result = parseDriftDecision({
      decision: 'reject',
      reason: '  the create form was mid-deploy  ',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).toEqual({
      decision: 'reject',
      reason: 'the create form was mid-deploy',
    });
    expect(DriftDecisionRequest.safeParse(result.request).success).toBe(true);
  });
});

describe('decisionIssuesFromGateway', () => {
  it('lands a reason refusal on the reason field', () => {
    const issues = decisionIssuesFromGateway([{ path: 'reason', message: 'required' }]);

    expect(issues.reason).toBe('required');
    expect(issues.form).toBeUndefined();
  });

  it('lands an already-decided refusal on the form, not on the reason', () => {
    const issues = decisionIssuesFromGateway([
      { path: 'id', message: 'the report is already approved' },
    ]);

    expect(issues.form).toBe('the report is already approved');
    expect(issues.reason).toBeUndefined();
  });

  it('keeps the first message per slot', () => {
    const issues = decisionIssuesFromGateway([
      { path: 'reason', message: 'first' },
      { path: 'reason', message: 'second' },
    ]);

    expect(issues.reason).toBe('first');
  });
});

describe('removeReport', () => {
  it('drops the named report and shrinks total by the rows actually removed', () => {
    const next = removeReport(DRIFT_LIST, DIFFED_REPORT.id);

    expect(next.reports.map((report) => report.id)).toEqual([OPEN_REPORT.id]);
    expect(next.total).toBe(1);
    expect(DriftListResponse.safeParse(next).success).toBe(true);
  });

  it('does not invent a negative total when the report is already gone', () => {
    const empty: DriftListResponse = { reports: [], total: 0 };
    expect(removeReport(empty, DIFFED_REPORT.id)).toEqual(empty);
  });

  it('leaves an unknown id untouched', () => {
    expect(removeReport(DRIFT_LIST, '00000000-0000-4000-8000-000000000000')).toEqual(DRIFT_LIST);
  });
});

describe('isPendingReport', () => {
  it('treats open, reconciling and diffed as pending, and decided reports as not', () => {
    expect(isPendingReport(DIFFED_REPORT)).toBe(true);
    expect(isPendingReport(OPEN_REPORT)).toBe(true);
    expect(isPendingReport({ ...DIFFED_REPORT, status: 'approved' })).toBe(false);
    expect(isPendingReport({ ...OPEN_REPORT, status: 'rejected' })).toBe(false);
  });
});

describe('fixtures match the contract', () => {
  it('parses the queued reports and the list', () => {
    expect(DriftReport.safeParse(DIFFED_REPORT).success).toBe(true);
    expect(DriftReport.safeParse(OPEN_REPORT).success).toBe(true);
    expect(DriftListResponse.safeParse(DRIFT_LIST).success).toBe(true);
  });
});
