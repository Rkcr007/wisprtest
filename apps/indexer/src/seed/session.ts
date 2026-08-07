import type { Page } from 'playwright';

import { applyFormLogin, prepareAuth } from '../crawl/auth.js';
import { openSession, type SessionBounds } from '../crawl/browser.js';
import { createUrlPolicy, type AddressLookup, type UrlPolicy } from '../crawl/url-policy.js';
import { SeedError } from '../errors.js';
import type { SeedApplication } from './repository.js';

/**
 * What every seed job needs before it can touch the application: a logged-in page, and a policy
 * saying where it may go.
 *
 * Shared by the two adapters rather than written twice. The UI adapter drives a form and the
 * HTTP adapters replay a request, but both arrive the same way — open a context, apply the
 * application's auth profile, and refuse any URL the SSRF policy does not allow. Duplicating that
 * would mean two chances to get authentication or the allowlist subtly wrong, and the one that was
 * wrong would be the one nobody was looking at.
 *
 * ## Why the API replay is a browser at all
 *
 * docs/TEST-DATA-ENGINE.md § 4 wants the API adapter to reuse the tester's live session. It gets
 * the same property here by construction: `page.request` shares the browser context's cookie jar,
 * so a replay issued through it is authenticated by the very session the form login established,
 * and no credential is copied anywhere to arrange it. See ADR 0013.
 */

/**
 * The viewport a seed session opens at.
 *
 * Fingerprint geometry is normalised against the viewport, so the bbox signal only agrees with the
 * stored value at the size the crawl indexed at. Irrelevant to an HTTP replay, and harmless there.
 */
export const SEED_VIEWPORT = { width: 1440, height: 900 } as const;

/**
 * Where a seed job is allowed to go: the application's own origin, and nowhere else.
 *
 * There is nothing for a tenant to configure and nothing a tampered plan could redirect — a job
 * navigates to the application it was registered for. The checks that matter still run on every
 * request: scheme, embedded credentials, and the address classes in `crawl/url-policy.ts`.
 *
 * This is also the reason a fixture endpoint on a *different* host cannot run today. Refusing it
 * is the honest outcome: the alternative is an allowlist bypass reached through a database column.
 */
export function createSeedPolicy(
  application: SeedApplication,
  lookup: AddressLookup | undefined,
): UrlPolicy {
  return createUrlPolicy(
    { allowedOrigins: [originOf(application.baseUrl)], routeAllowlist: ['/'] },
    lookup ?? defaultAddressLookup,
  );
}

export interface AuthenticatedPageOptions {
  readonly application: SeedApplication;
  readonly policy: UrlPolicy;
  readonly browser: import('playwright').Browser;
  readonly secrets: import('../crawl/secrets.js').SecretResolver;
  readonly deadlineMs: number;
  /**
   * Viewport to open at. Defaults to {@link SEED_VIEWPORT}.
   *
   * Worth overriding whenever the caller knows the size the fingerprints it is about to compare
   * against were normalised to — `memory_versions.viewport_width/height`, recorded since
   * db/migrations/20260806130000_memory_version_viewport.sql. Matching it is what makes the bbox
   * signal mean anything; the default is the honest fallback for a version crawled before that
   * was recorded.
   */
  readonly viewport?: { readonly width: number; readonly height: number };
}

/**
 * Open a logged-in page, run `work`, and close it whatever happened.
 *
 * The login is applied before `work` sees the page, so a caller cannot forget it and quietly seed
 * as an anonymous user — which either fails confusingly at a form or, worse, writes whatever an
 * anonymous session can reach.
 */
export async function withAuthenticatedPage<T>(
  options: AuthenticatedPageOptions,
  work: (page: Page) => Promise<T>,
): Promise<T> {
  const bounds: SessionBounds = {
    viewport: options.viewport ?? SEED_VIEWPORT,
    navigationTimeoutMs: Math.min(options.deadlineMs, 60_000),
  };

  const auth = await prepareAuth(options.application.authProfile, options.secrets);
  const session = await openSession({ browser: options.browser, bounds, auth });

  try {
    await applyFormLogin({
      page: session.page,
      profile: options.application.authProfile,
      baseUrl: options.application.baseUrl,
      bounds,
      policy: options.policy,
      resolver: options.secrets,
    });

    return await work(session.page);
  } finally {
    await session.close();
  }
}

export function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    throw new SeedError(`the application's base URL is not a URL: ${baseUrl}`);
  }
}

/**
 * Bound the whole job, not each request.
 *
 * Playwright's per-action timeouts add up: a form with twelve controls could spend twelve
 * navigation timeouts failing slowly, long after the gateway gave up waiting for a result and the
 * tester saw an error. One ceiling over the whole job is what the gateway's own wait is sized
 * against.
 */
export async function withDeadline<T>(
  deadlineMs: number,
  work: Promise<T>,
  onTimeout: () => T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(onTimeout());
    }, deadlineMs);
  });

  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function defaultAddressLookup(hostname: string): Promise<readonly string[]> {
  const { lookup } = await import('node:dns/promises');
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

/** One line, never a stack: this ends up in a result the tester reads. */
export function describe(error: unknown): string {
  if (error instanceof SeedError) return error.message;
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return 'unknown error';
}
