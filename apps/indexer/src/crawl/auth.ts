import type { Page } from 'playwright';
import type { AuthProfile, CrawlBounds } from 'protocol';

import { AuthError } from '../errors.js';
import { resolveCredentials, resolveStorageState, type SecretResolver } from './secrets.js';
import type { UrlPolicy } from './url-policy.js';

/**
 * Applying an application's auth profile.
 *
 * Two supported shapes, per docs/BUILD-PLAN.md Phase 5:
 *
 * - **Form login**, with credentials fetched from the tenant's configured secret reference at the
 *   moment of use.
 * - **A storage state** captured by the tester, which is how you index an application behind SSO
 *   without WisprTest ever holding an SSO credential.
 *
 * ## Why the two are applied at different times
 *
 * A storage state has to exist *before* the browser context does — Playwright seeds cookies and
 * local storage at context creation — so {@link prepareAuth} resolves it and the caller passes
 * the result to `newContext`. A form login needs a page to type into, so it runs after. Splitting
 * the phases keeps the browser module free of any knowledge about credentials.
 *
 * ## Locating the login controls
 *
 * By accessible name, never by CSS selector. That is the same notion of identity the resolver
 * uses at runtime, so a login form that gets restyled keeps working, and a tenant configuring a
 * profile writes down what they *see* ("Email address") rather than reverse-engineering markup.
 */

/** What has to be handed to `browser.newContext()` for this profile. */
export interface PreparedAuth {
  /** Playwright storage state, when the profile supplies one. */
  readonly storageState?: Awaited<ReturnType<typeof resolveStorageState>>;
}

/** Resolve anything the browser context needs at creation time. */
export async function prepareAuth(
  profile: AuthProfile,
  resolver: SecretResolver,
): Promise<PreparedAuth> {
  if (profile.kind !== 'storage_state') return {};
  return { storageState: await resolveStorageState(resolver, profile.stateRef) };
}

export interface FormLoginOptions {
  readonly page: Page;
  readonly profile: AuthProfile;
  readonly baseUrl: string;
  readonly bounds: Pick<CrawlBounds, 'navigationTimeoutMs'>;
  readonly policy: UrlPolicy;
  readonly resolver: SecretResolver;
}

/**
 * Complete a form login, if the profile calls for one.
 *
 * Success is defined by the profile's `successPath`, not by the absence of an error. A login form
 * that re-renders with "invalid password" is a 200 response and a settled page; only the
 * destination distinguishes it from a login that worked, and a crawl that proceeds unauthenticated
 * would index the login screen a hundred times over and call it a memory version.
 */
export async function applyFormLogin(options: FormLoginOptions): Promise<void> {
  const { page, profile, policy, bounds } = options;
  if (profile.kind !== 'form') return;

  const loginUrl = await policy.assertAllowed(profile.loginPath, options.baseUrl);
  const credentials = await resolveCredentials(options.resolver, profile.credentialsRef);

  await page.goto(loginUrl.href, {
    waitUntil: 'domcontentloaded',
    timeout: bounds.navigationTimeoutMs,
  });

  try {
    await fill(page, profile.usernameLabel, credentials.username, bounds.navigationTimeoutMs);
    await fill(page, profile.passwordLabel, credentials.password, bounds.navigationTimeoutMs, {
      // A password input has no ARIA role of its own, so when one is unlabelled there is nothing
      // semantic left to key on. This is the one selector in the crawl path, and it is a type
      // check rather than a structural one — it cannot break when the page is restyled.
      fallbackSelector: 'input[type="password"]',
    });
  } catch (error: unknown) {
    // The message names the label that could not be found; it cannot name a credential, because
    // `fill` is never given one to report.
    throw new AuthError(describe(error), { loginPath: profile.loginPath });
  }

  const submit = page.getByRole('button', { name: profile.submitLabel });
  await submit
    .click({ timeout: bounds.navigationTimeoutMs })
    .catch(async () =>
      // Some login forms submit from a link or an `<input type=submit>`, which is not
      // `role=button` in every markup. Falling back by accessible name keeps those working.
      page
        .getByText(profile.submitLabel, { exact: false })
        .first()
        .click({ timeout: bounds.navigationTimeoutMs }),
    )
    .catch((error: unknown) => {
      throw new AuthError(`could not activate "${profile.submitLabel}": ${describe(error)}`);
    });

  const expected = new URL(profile.successPath, options.baseUrl);
  try {
    await page.waitForURL((url) => url.pathname === expected.pathname, {
      timeout: bounds.navigationTimeoutMs,
    });
  } catch {
    throw new AuthError(
      `login did not reach ${profile.successPath} within ${String(bounds.navigationTimeoutMs)}ms`,
      { successPath: profile.successPath },
    );
  }

  // The destination is still a navigation target and is still subject to the policy: a login
  // that redirects off the allowlist has taken the crawler somewhere it may not be.
  await policy.assertAllowed(page.url());
}

/**
 * Fill a control identified by its accessible name.
 *
 * `getByLabel` first, because a labelled field is the common case and the association is the one
 * assistive technology uses. `getByRole` covers the fields labelled by `aria-label` alone.
 */
async function fill(
  page: Page,
  label: string,
  value: string,
  timeoutMs: number,
  options: { readonly fallbackSelector?: string } = {},
): Promise<void> {
  const byLabel = page.getByLabel(label, { exact: false });
  if ((await byLabel.count()) > 0) {
    await byLabel.first().fill(value, { timeout: timeoutMs });
    return;
  }

  const byRole = page.getByRole('textbox', { name: label, exact: false });
  if ((await byRole.count()) > 0) {
    await byRole.first().fill(value, { timeout: timeoutMs });
    return;
  }

  const { fallbackSelector } = options;
  if (fallbackSelector !== undefined) {
    const bySelector = page.locator(fallbackSelector);
    if ((await bySelector.count()) > 0) {
      await bySelector.first().fill(value, { timeout: timeoutMs });
      return;
    }
  }

  throw new AuthError(`no control on the login page is named "${label}"`);
}

function describe(error: unknown): string {
  if (error instanceof AuthError) return error.message;
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return 'unknown error';
}
