import { describe, expect, it } from 'vitest';

import { OPEN_FALSE_EXECUTION, WITHDRAWN_FALSE_EXECUTION } from '../drift/fixtures';
import {
  parseReport,
  parseWithdrawal,
  reportForStep,
  reportIssuesFromGateway,
} from './false-execution';

/**
 * The rules a false-execution report is held to before it leaves the browser.
 *
 * This is the numerator of a release gate, so the properties worth locking are the ones that
 * would let it drift from the truth: a report with no stated reason, a withdrawal with no
 * explanation, and a note that is empty rather than absent.
 */

describe('parseReport', () => {
  it('builds a contract-valid request from a reason alone', () => {
    const result = parseReport({ stepOrdinal: 4, reason: 'wrong_element', note: '' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.stepOrdinal).toBe(4);
    expect(result.request.reason).toBe('wrong_element');
    // Absent, not empty. The contract types the note as nullable and the two are different
    // claims: null is "the tester added nothing", '' is a note that says nothing.
    expect(result.request.note).toBeNull();
  });

  it('trims a note and keeps it when there is something in it', () => {
    const result = parseReport({
      stepOrdinal: 0,
      reason: 'wrong_action',
      note: '  it archived instead of approving  ',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.note).toBe('it archived instead of approving');
  });

  it('always sends a null expectedElementId from this screen', () => {
    const result = parseReport({ stepOrdinal: 1, reason: 'wrong_element', note: '' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The console has no honest element picker yet, and a raw UUID box would be worse than
    // nothing. The contract makes the field nullable for exactly this case.
    expect(result.request.expectedElementId).toBeNull();
  });

  it('refuses a report with no reason chosen', () => {
    const result = parseReport({ stepOrdinal: 4, reason: '', note: 'something was off' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.reason).toBeDefined();
  });

  it('refuses a reason outside the contract', () => {
    const result = parseReport({ stepOrdinal: 4, reason: 'mistake', note: '' });

    expect(result.ok).toBe(false);
  });
});

describe('parseWithdrawal', () => {
  it('accepts a reason and trims it', () => {
    const result = parseWithdrawal('  filed against the wrong step  ');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.reason).toBe('filed against the wrong step');
  });

  it.each(['', '   '])('refuses %j, because a withdrawal moves a release gate', (reason) => {
    const result = parseWithdrawal(reason);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.reason).toBeDefined();
  });
});

describe('reportForStep', () => {
  it('finds the report for that step and no other', () => {
    expect(reportForStep([OPEN_FALSE_EXECUTION], 4)?.id).toBe(OPEN_FALSE_EXECUTION.id);
    expect(reportForStep([OPEN_FALSE_EXECUTION], 5)).toBeNull();
    expect(reportForStep([], 4)).toBeNull();
  });

  it('prefers the open report when a step was reported, withdrawn and reported again', () => {
    const refiled = { ...OPEN_FALSE_EXECUTION, id: 'c56a4180-65aa-42ec-a945-5fd21dec0540' };

    // Withdrawn first in the list, to prove the choice is by status rather than by order.
    const found = reportForStep([WITHDRAWN_FALSE_EXECUTION, refiled], 4);

    expect(found?.id).toBe(refiled.id);
    expect(found?.status).toBe('open');
  });

  it('still surfaces a withdrawn report when that is all there is', () => {
    // Shown, not hidden — otherwise a retraction looks like it never happened.
    expect(reportForStep([WITHDRAWN_FALSE_EXECUTION], 4)?.status).toBe('withdrawn');
  });
});

describe('reportIssuesFromGateway', () => {
  it('puts a field issue on its field and everything else on the form', () => {
    const issues = reportIssuesFromGateway([
      { path: 'reason', message: 'a withdrawal names why' },
      { path: 'note', message: 'the note is not text' },
      { path: 'stepOrdinal', message: 'session has no step at that ordinal' },
    ]);

    expect(issues.reason).toBe('a withdrawal names why');
    expect(issues.note).toBe('the note is not text');
    // Not a field the tester typed into — it is about the row, so it belongs on the form.
    expect(issues.form).toBe('session has no step at that ordinal');
  });

  it('keeps the first message for a field rather than the last', () => {
    const issues = reportIssuesFromGateway([
      { path: 'reason', message: 'first' },
      { path: 'reason', message: 'second' },
    ]);

    expect(issues.reason).toBe('first');
  });
});
