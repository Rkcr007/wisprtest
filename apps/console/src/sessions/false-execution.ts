import {
  FalseExecutionReportRequest,
  FalseExecutionWithdrawRequest,
  type FalseExecutionReason,
  type FalseExecutionReport,
} from 'protocol';

/**
 * A tester's report that one step acted on the wrong thing, parsed before it leaves the browser.
 *
 * This is the human end of the release gate. `CLAUDE.md` budgets false execution at < 0.1% and
 * calls it the metric that gates every release, but a false execution is not something the
 * runtime can detect — the resolver was confident and the dispatch succeeded. Only the person
 * watching the screen knows, and this is where they say so.
 *
 * As in `../drift/decision`, this module knows nothing about roles. The gateway decides whether
 * a caller may file or withdraw; a refusal reaches the tester as the gateway's own sentence
 * rather than as a button that was never rendered.
 */

/** The contract's three reasons, in the words a tester reads. The enum is the contract. */
export const REASON_LABELS: Readonly<Record<FalseExecutionReason, string>> = {
  wrong_element: 'Wrong element',
  wrong_action: 'Wrong action',
  unintended_state_change: 'Unintended state change',
};

/**
 * What each reason means, shown beside the choice.
 *
 * They are not interchangeable and they are fixed differently: a wrong element is the alias
 * corpus, a wrong action is the verb, and an unintended state change is the application's own
 * bug. A tester who picks the nearest-sounding one makes the counter unactionable.
 */
export const REASON_HINTS: Readonly<Record<FalseExecutionReason, string>> = {
  wrong_element: 'It acted on something other than what I named.',
  wrong_action: 'The right thing, but it did the wrong thing to it.',
  unintended_state_change: 'It did what I asked, and something else changed too.',
};

export const REASONS: readonly FalseExecutionReason[] = [
  'wrong_element',
  'wrong_action',
  'unintended_state_change',
];

export type ReportField = 'reason' | 'note' | 'form';

export type ReportIssues = Partial<Record<ReportField, string>>;

export interface ReportValues {
  readonly stepOrdinal: number;
  readonly reason: string;
  readonly note: string;
}

export type ReportResult =
  | { readonly ok: true; readonly request: FalseExecutionReportRequest }
  | { readonly ok: false; readonly issues: ReportIssues };

/**
 * Turn the on-screen form into a contract-valid `FalseExecutionReportRequest`.
 *
 * An empty note becomes `null` rather than `''`. The contract types it as nullable, and the two
 * are different claims: `null` is "the tester added nothing", `''` is a note that says nothing.
 *
 * `expectedElementId` is always `null` from this screen. The contract makes it nullable because
 * a tester often knows an action was wrong without knowing what the right target was, and the
 * only input the console could honestly offer for it today is a raw UUID box. Choosing the
 * intended element belongs with a memory-explorer picker.
 */
export function parseReport(values: ReportValues): ReportResult {
  if (values.reason === '') {
    return {
      ok: false,
      issues: {
        reason: 'Say what went wrong — the three reasons are fixed in different places.',
      },
    };
  }

  const note = values.note.trim();
  const parsed = FalseExecutionReportRequest.safeParse({
    stepOrdinal: values.stepOrdinal,
    reason: values.reason,
    expectedElementId: null,
    note: note.length === 0 ? null : note,
  });

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path[0];
    const message = first === undefined ? 'the report is incomplete' : first.message;
    return {
      ok: false,
      issues: field === 'note' ? { note: message } : { reason: message },
    };
  }

  return { ok: true, request: parsed.data };
}

export type WithdrawResult =
  | { readonly ok: true; readonly request: FalseExecutionWithdrawRequest }
  | { readonly ok: false; readonly issues: ReportIssues };

/**
 * Parse a withdrawal.
 *
 * The reason is required, unlike the report's own note. Withdrawing moves a number that gates
 * releases, so it is the one action here that must explain itself — the same standard the drift
 * rejection branch holds itself to. The gateway enforces this as well; checking here is what
 * stops a tester spending a round trip to be told.
 */
export function parseWithdrawal(reason: string): WithdrawResult {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      issues: {
        reason: 'A withdrawal names why — it moves the number that gates a release.',
      },
    };
  }

  const parsed = FalseExecutionWithdrawRequest.safeParse({ reason: trimmed });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      issues: { reason: first === undefined ? 'the withdrawal is incomplete' : first.message },
    };
  }

  return { ok: true, request: parsed.data };
}

/**
 * The report standing against one step, or null.
 *
 * An open report wins over a withdrawn one: the partial unique index means at most one can be
 * open at a time, but a step reported, withdrawn and reported again has two rows, and the live
 * one is what the row should show.
 */
export function reportForStep(
  reports: readonly FalseExecutionReport[],
  stepOrdinal: number,
): FalseExecutionReport | null {
  const forStep = reports.filter((report) => report.stepOrdinal === stepOrdinal);
  return forStep.find((report) => report.status === 'open') ?? forStep[0] ?? null;
}

/**
 * A gateway `validation_failed` mapped onto the form.
 *
 * The gateway names `stepOrdinal` when the ordinal matches no step, `reason` when a withdrawal
 * has none, and `ordinal`/`id` when the report or session itself cannot be acted on. Only the
 * first belongs on a field; the rest are about the row, not about anything the tester typed.
 */
export function reportIssuesFromGateway(
  gatewayIssues: readonly { readonly path: string; readonly message: string }[],
): ReportIssues {
  const issues: ReportIssues = {};

  for (const issue of gatewayIssues) {
    const head = issue.path.split('.')[0] ?? '';
    if (head === 'reason') {
      issues.reason ??= issue.message;
    } else if (head === 'note') {
      issues.note ??= issue.message;
    } else {
      issues.form ??= issue.message;
    }
  }

  return issues;
}
