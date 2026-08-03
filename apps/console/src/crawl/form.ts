import { AuthProfile, CrawlBounds } from 'protocol';
import { z } from 'zod';

import type { StartCrawlRequest } from './request';

/**
 * The Connect form: its values, and the one function that turns them into a contract-valid crawl
 * request.
 *
 * Pure and framework-free, so every rule below is asserted in `form.test.ts` rather than through
 * a rendered component.
 *
 * ## What is pre-filled, and what is deliberately not
 *
 * `CrawlBounds` has no defaults, on purpose: docs/BUILD-PLAN.md Phase 5 requires a crawl to
 * "refuse to start without them", and `packages/protocol` makes every field required so the
 * refusal happens at validation rather than in a check somebody forgets. A console that quietly
 * pre-filled a page cap would preserve the letter of that and destroy the point — the bound would
 * be WisprTest's decision wearing the tester's name.
 *
 * So the four bounds that decide *blast radius* start empty and the form will not submit without
 * them: the origins the crawler may visit, the paths it may enter, how deep it may go, and how
 * many pages it may take. The remaining fields are operational tuning — timeouts, the navigation
 * rate ceiling, the viewport — and those are pre-filled with visible, editable values, because
 * making somebody invent a network-idle timeout before they can index anything is friction with
 * no safety in it.
 *
 * The never-interact list is the special case. An empty list is legitimate (a read-only
 * application has nothing to exclude) but it must be a decision, so an empty list requires the
 * acknowledgement checkbox. Unticked, it is refused here.
 */

export interface CrawlFormValues {
  readonly applicationId: string;
  readonly allowedOrigins: string;
  readonly routeAllowlist: string;
  readonly maxDepth: string;
  readonly maxPages: string;
  readonly neverInteractSelectors: string;
  readonly noDestructiveControls: boolean;
  readonly maxInteractionsPerRoute: string;
  readonly interactionObserveMs: string;
  readonly settleDelayMs: string;
  readonly networkIdleTimeoutMs: string;
  readonly navigationTimeoutMs: string;
  readonly requestsPerMinute: string;
  readonly viewportWidth: string;
  readonly viewportHeight: string;
  readonly authKind: 'none' | 'form' | 'storage_state';
  readonly loginPath: string;
  readonly usernameLabel: string;
  readonly passwordLabel: string;
  readonly submitLabel: string;
  readonly successPath: string;
  readonly credentialsProvider: 'env' | 'file';
  readonly credentialsKey: string;
  readonly stateProvider: 'env' | 'file';
  readonly stateKey: string;
}

export type CrawlFormField = keyof CrawlFormValues;

/** Field-level messages, keyed by form field. `form` holds anything not attributable to one. */
export type CrawlFormIssues = Partial<Record<CrawlFormField | 'form', string>>;

export const initialCrawlForm: CrawlFormValues = {
  applicationId: '',
  // Empty on purpose — see the note above. These four are the crawl's blast radius.
  allowedOrigins: '',
  routeAllowlist: '',
  maxDepth: '',
  maxPages: '',
  neverInteractSelectors: '',
  noDestructiveControls: false,
  // Operational tuning, pre-filled and visible.
  maxInteractionsPerRoute: '20',
  interactionObserveMs: '1200',
  settleDelayMs: '400',
  networkIdleTimeoutMs: '5000',
  navigationTimeoutMs: '30000',
  requestsPerMinute: '60',
  viewportWidth: '1440',
  viewportHeight: '900',
  authKind: 'none',
  loginPath: '',
  usernameLabel: '',
  passwordLabel: '',
  submitLabel: '',
  successPath: '',
  credentialsProvider: 'env',
  credentialsKey: '',
  stateProvider: 'env',
  stateKey: '',
};

export type CrawlFormResult =
  | { readonly ok: true; readonly applicationId: string; readonly request: StartCrawlRequest }
  | { readonly ok: false; readonly issues: CrawlFormIssues };

/** One entry per non-empty line, trimmed. The textareas are line-per-value throughout. */
export function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** `NaN` for anything that is not a number, which every numeric bound then rejects. */
function toNumber(value: string): number {
  const trimmed = value.trim();
  return trimmed === '' ? Number.NaN : Number(trimmed);
}

export function parseCrawlForm(values: CrawlFormValues): CrawlFormResult {
  const issues: CrawlFormIssues = {};

  const applicationId = z.uuid().safeParse(values.applicationId.trim());
  if (!applicationId.success) {
    issues.applicationId = 'Enter the application’s UUID.';
  }

  const selectors = lines(values.neverInteractSelectors);
  if (selectors.length === 0 && !values.noDestructiveControls) {
    issues.neverInteractSelectors =
      'List the controls the crawl must never click, or confirm there are none.';
  }

  const bounds = CrawlBounds.safeParse({
    allowedOrigins: lines(values.allowedOrigins),
    routeAllowlist: lines(values.routeAllowlist),
    maxDepth: toNumber(values.maxDepth),
    maxPages: toNumber(values.maxPages),
    neverInteractSelectors: selectors,
    maxInteractionsPerRoute: toNumber(values.maxInteractionsPerRoute),
    interactionObserveMs: toNumber(values.interactionObserveMs),
    settleDelayMs: toNumber(values.settleDelayMs),
    networkIdleTimeoutMs: toNumber(values.networkIdleTimeoutMs),
    navigationTimeoutMs: toNumber(values.navigationTimeoutMs),
    requestsPerMinute: toNumber(values.requestsPerMinute),
    viewport: { width: toNumber(values.viewportWidth), height: toNumber(values.viewportHeight) },
  });

  if (!bounds.success) {
    for (const issue of bounds.error.issues) {
      const field = boundsField(issue.path);
      issues[field] ??= issue.message;
    }
  }

  const profile = AuthProfile.safeParse(authProfileInput(values));
  if (!profile.success) {
    for (const issue of profile.error.issues) {
      const field = authField(values.authKind, issue.path);
      issues[field] ??= issue.message;
    }
  }

  if (Object.keys(issues).length > 0 || !bounds.success || !profile.success) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    applicationId: values.applicationId.trim(),
    request: { bounds: bounds.data, authProfile: profile.data },
  };
}

function authProfileInput(values: CrawlFormValues): unknown {
  switch (values.authKind) {
    case 'none':
      return { kind: 'none' };
    case 'form':
      return {
        kind: 'form',
        loginPath: values.loginPath.trim(),
        usernameLabel: values.usernameLabel.trim(),
        passwordLabel: values.passwordLabel.trim(),
        submitLabel: values.submitLabel.trim(),
        credentialsRef: {
          provider: values.credentialsProvider,
          key: values.credentialsKey.trim(),
        },
        successPath: values.successPath.trim(),
      };
    case 'storage_state':
      return {
        kind: 'storage_state',
        stateRef: { provider: values.stateProvider, key: values.stateKey.trim() },
      };
  }
}

/** Which input a `CrawlBounds` issue belongs under. */
function boundsField(path: readonly PropertyKey[]): CrawlFormField | 'form' {
  const head = String(path[0] ?? '');
  switch (head) {
    case 'allowedOrigins':
      return 'allowedOrigins';
    case 'routeAllowlist':
      return 'routeAllowlist';
    case 'maxDepth':
      return 'maxDepth';
    case 'maxPages':
      return 'maxPages';
    case 'neverInteractSelectors':
      return 'neverInteractSelectors';
    case 'maxInteractionsPerRoute':
      return 'maxInteractionsPerRoute';
    case 'interactionObserveMs':
      return 'interactionObserveMs';
    case 'settleDelayMs':
      return 'settleDelayMs';
    case 'networkIdleTimeoutMs':
      return 'networkIdleTimeoutMs';
    case 'navigationTimeoutMs':
      return 'navigationTimeoutMs';
    case 'requestsPerMinute':
      return 'requestsPerMinute';
    case 'viewport':
      return String(path[1] ?? '') === 'height' ? 'viewportHeight' : 'viewportWidth';
    default:
      return 'form';
  }
}

/** Which input an `AuthProfile` issue belongs under, given the variant on screen. */
function authField(
  kind: CrawlFormValues['authKind'],
  path: readonly PropertyKey[],
): CrawlFormField | 'form' {
  const head = String(path[0] ?? '');
  switch (head) {
    case 'loginPath':
      return 'loginPath';
    case 'usernameLabel':
      return 'usernameLabel';
    case 'passwordLabel':
      return 'passwordLabel';
    case 'submitLabel':
      return 'submitLabel';
    case 'successPath':
      return 'successPath';
    case 'credentialsRef':
      return 'credentialsKey';
    case 'stateRef':
      return 'stateKey';
    default:
      // A discriminated-union failure has no field of its own. It belongs to whichever key the
      // variant on screen is keyed by, and that is the one the tester can act on.
      return kind === 'storage_state' ? 'stateKey' : 'form';
  }
}

/**
 * A gateway `validation_failed` mapped back onto the form.
 *
 * The gateway validates the same bounds against the same schema and adds one check the console
 * cannot make: that the allowlist covers the origin the application is *registered* at, which
 * only the applications row knows. That refusal names `bounds.allowedOrigins`, and it belongs on
 * that field rather than in a banner at the top of a long form.
 */
export function issuesFromGateway(
  gatewayIssues: readonly { readonly path: string; readonly message: string }[],
): CrawlFormIssues {
  const issues: CrawlFormIssues = {};

  for (const issue of gatewayIssues) {
    const path = issue.path.split('.');
    const scope = path[0];
    const rest = path.slice(1);
    const field =
      scope === 'bounds'
        ? boundsField(rest)
        : scope === 'authProfile'
          ? authField('none', rest)
          : // The crawl route reports an unknown application as an issue on `id`.
            scope === 'id'
            ? 'applicationId'
            : 'form';
    issues[field] ??= issue.message;
  }

  return issues;
}
