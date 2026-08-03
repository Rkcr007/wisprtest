import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { CrawlBounds } from 'protocol';

import { BrowserError } from '../errors.js';
import { fingerprintBundle } from './fingerprint-bundle.js';
import type { PreparedAuth } from './auth.js';

/**
 * The browser, and the one context each crawl job runs in.
 *
 * A context per job rather than a browser per job: contexts are isolated in cookies, storage and
 * cache, which is the isolation that matters between two tenants' applications, and they cost
 * milliseconds where a browser costs a second or more. One browser is launched per worker process
 * and reused.
 *
 * The in-page collector is injected with `addInitScript`, which runs before the page's own
 * scripts on every document in the context — including after a client-side route change. The
 * alternative, evaluating the bundle after each navigation, races with pages that navigate
 * themselves and costs a round trip per route.
 */

export interface CrawlSession {
  readonly context: BrowserContext;
  readonly page: Page;
  close(): Promise<void>;
}

/** Launch the shared browser. One per worker process. */
export async function launchBrowser(headless: boolean): Promise<Browser> {
  try {
    return await chromium.launch({
      headless,
      args: [
        // The crawler visits a customer's staging application and clicks around in it. Site
        // isolation stays on; nothing here weakens the sandbox.
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
      ],
    });
  } catch (error: unknown) {
    throw new BrowserError(
      `could not launch chromium: ${error instanceof Error ? error.message : String(error)} ` +
        '(run `pnpm --filter indexer browsers:install` if the browser is missing)',
      { cause: error },
    );
  }
}

/**
 * What opening a context actually depends on.
 *
 * A `Pick` rather than the whole of `CrawlBounds` because the UI materializer opens a context too
 * (`seed/materializer.ts`) and has no crawl to be bounded by — no depth, no page cap, no
 * never-interact list. Narrowing the parameter is what lets the seed path share this function
 * instead of growing a second one that launches browsers slightly differently.
 */
export type SessionBounds = Pick<CrawlBounds, 'viewport' | 'navigationTimeoutMs'>;

export interface SessionOptions {
  readonly browser: Browser;
  readonly bounds: SessionBounds;
  readonly auth: PreparedAuth;
}

/** Open the context one job runs in, with the collector already injected. */
export async function openSession(options: SessionOptions): Promise<CrawlSession> {
  const { browser, bounds, auth } = options;

  const context = await browser.newContext({
    viewport: { width: bounds.viewport.width, height: bounds.viewport.height },
    // Fingerprint geometry is normalised against the viewport, so a device pixel ratio that
    // varies between the crawl machine and the tester's would make the bbox signal disagree.
    deviceScaleFactor: 1,
    // Announcing the crawler is a courtesy to whoever reads the application's access logs and
    // wonders what is clicking through their staging environment at four in the morning.
    userAgent: await crawlerUserAgent(browser),
    ...(auth.storageState === undefined ? {} : { storageState: auth.storageState }),
  });

  context.setDefaultNavigationTimeout(bounds.navigationTimeoutMs);
  context.setDefaultTimeout(bounds.navigationTimeoutMs);

  await context.addInitScript({ content: await fingerprintBundle() });

  const page = await context.newPage();

  return {
    context,
    page,
    async close(): Promise<void> {
      await context.close();
    },
  };
}

/**
 * The browser's own user agent, with the crawler's name appended.
 *
 * Read from the browser rather than hand-written, so it stays truthful across Chromium upgrades,
 * and memoised because it costs a context to obtain. The suffix is a courtesy to whoever reads
 * the application's access logs and wonders what is clicking through their staging environment.
 *
 * `evaluate` is given a string expression rather than a function: this file is compiled without
 * DOM types — it runs in Node — so `navigator` has no meaning here at compile time.
 */
const userAgents = new WeakMap<Browser, Promise<string>>();

function crawlerUserAgent(browser: Browser): Promise<string> {
  const cached = userAgents.get(browser);
  if (cached !== undefined) return cached;

  const pending = (async () => {
    const probe = await browser.newContext();
    try {
      const page = await probe.newPage();
      const base = await page.evaluate<string>('navigator.userAgent');
      return `${base} WisprTest-Indexer`;
    } finally {
      await probe.close();
    }
  })();

  userAgents.set(browser, pending);
  return pending;
}
