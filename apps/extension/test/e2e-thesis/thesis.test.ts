import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startFixtureApp, type FixtureApp } from '../../../indexer/test/fixture-app/server.js';
import { WORKSPACE_ALIASES } from '../../src/build.js';
import type { CdpCommand } from '../../src/executor/index.js';
import { runCdpCommand } from '../../src/executor/cdp.js';
import { expectContainsText } from '../e2e/expect-locator.js';
import { buildFixtureSnapshot } from './snapshot.js';

/**
 * The product thesis, end to end, against the live fixture application.
 *
 * The four sentences the README advertises, spoken (typed) in order, through the shipping
 * parser → resolver → speculation controller → CDP executor. A failure here is a failure of
 * Remember → Execute, not of a unit.
 */

let app: FixtureApp | undefined;
let browser: Browser | undefined;
let page: Page;
let session: CDPSession;
let harnessJs: string;

async function bundleHarness(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./harness.entry.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'chrome116',
    jsx: 'automatic',
    alias: { ...WORKSPACE_ALIASES },
    define: {
      'process.env.NODE_ENV': JSON.stringify('development'),
      __WISPR_THESIS_SNAPSHOT__: JSON.stringify(buildFixtureSnapshot()),
    },
    logLevel: 'warning',
  });
  return result.outputFiles[0]?.text ?? '';
}

async function ready(): Promise<void> {
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.wisprThesisReady === 'true' ||
      document.documentElement.dataset.wisprThesisError !== undefined,
  );
  const error = await page.evaluate(() => document.documentElement.dataset.wisprThesisError);
  if (error !== undefined) throw new Error(`thesis harness failed: ${error}`);
}

async function confirmIfAsked(): Promise<void> {
  const asked = await page.evaluate(() => window.wisprView().awaitingConfirmation);
  if (!asked) return;
  try {
    await page.evaluate(() => {
      window.wisprConfirm();
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';
    if (!message.includes('Execution context was destroyed')) throw error;
  }
  await ready();
}

async function command(transcript: string): Promise<void> {
  // A class-R navigate tears the page down mid-evaluate. That is success, not a harness bug.
  try {
    await page.evaluate((text) => window.wisprCommand(text), transcript);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';
    if (!message.includes('Execution context was destroyed')) throw error;
  }
  await ready();
  // SpeculationView has no `final`/`stable` fields. The class-C window is 150 ms; wait past it
  // before offering the tester's yes, or tryCommitPending returns without dispatching.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 250);
  });
  await confirmIfAsked();
}

beforeAll(async () => {
  harnessJs = await bundleHarness();
  const fixture = await startFixtureApp();
  app = fixture;
  const launched = await chromium.launch({ channel: 'chromium' });
  browser = launched;
  page = await launched.newPage();
  session = await page.context().newCDPSession(page);

  await page.exposeFunction('wisprCdp', async (command: CdpCommand) => {
    // Playwright's page.mouse is the same Input domain the executor speaks, driven from Node so
    // the page is not paused inside an exposeFunction while the event is delivered. A direct
    // CDPSession.send from that callback delivered the events after the page had already moved on,
    // and the fixture's <a> never navigated.
    if (command.kind === 'mouse') {
      await page.mouse.move(command.event.x, command.event.y);
      if (command.event.type === 'mousePressed') await page.mouse.down();
      if (command.event.type === 'mouseReleased') await page.mouse.up();
      return;
    }
    const rawSend = session.send.bind(session) as (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    await runCdpCommand((method, params) => rawSend(method, params), command);
  });

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  page.on('load', () => {
    void page
      .evaluate(() => document.documentElement.dataset.wisprThesisReady === 'true')
      .then((already) => {
        if (already) return;
        return page.addScriptTag({ content: harnessJs });
      })
      .catch((error: unknown) => {
        pageErrors.push(error instanceof Error ? error.message : 'addScriptTag failed');
      });
  });
  await page.goto(fixture.url);
  try {
    await ready();
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : 'ready failed'}; page errors: ${pageErrors.join(' | ')}`,
      { cause: error },
    );
  }
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
});

describe('Remember → Execute against the fixture app', () => {
  it('runs the four demo sentences as a tester would', async () => {
    if (app === undefined) throw new Error('fixture app did not start');
    expect(new URL(page.url()).pathname).toBe('/');

    // 1. "open orders" — class R navigate, no confirmation.
    await command('open orders');
    expect(new URL(page.url()).pathname).toBe('/orders');

    // 2. "show me only the pending ones" — the advertised paraphrase, not the button label.
    await command('show me only the pending ones');
    if (new URL(page.url()).searchParams.get('status') !== 'pending') {
      throw new Error(
        `"show me only the pending ones" did not filter: ${JSON.stringify(await page.evaluate(() => window.wisprDebug()))} href=${page.url()}`,
      );
    }

    // 3. Seeding is class S: the utterance is recognised and nothing is written.
    const ordersBefore = app.state.orders.length;
    await command('I need a pending order for Acme with three line items');
    expect(await page.evaluate(() => window.wisprWasSeed())).toBe(true);
    expect(app.state.orders).toHaveLength(ordersBefore);

    // Setup for "approve it": open the first pending row. The demo assumes the tester is
    // looking at the record they just asked for; without a composer here, the first pending
    // row is that record.
    const firstView = page.locator('[data-testid^="order-view-"]').first();
    await firstView.click();
    await page.waitForURL((url) => /\/orders\/\d+$/.test(url.pathname), { timeout: 15_000 });
    await ready();

    // 4. "approve it" — class C: staged, then confirmed.
    await command('approve it');
    await page.waitForFunction(() => window.wisprView().awaitingConfirmation);
    await page.waitForTimeout(200);
    try {
      await page.evaluate(() => {
        window.wisprConfirm();
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '';
      if (!message.includes('Execution context was destroyed')) throw error;
    }
    await ready();

    await expectContainsText(page.locator('section[aria-label="Order detail"]'), 'approved');
    const approvedId = Number(/\/orders\/(\d+)$/.exec(new URL(page.url()).pathname)?.[1]);
    expect(Number.isFinite(approvedId)).toBe(true);
    expect(app.state.find(approvedId)?.status).toBe('approved');
  });
});
