import { chromium, type Browser, type CDPSession, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDebuggerDispatcher,
  keyEventsForChar,
  type SendCommand,
} from '../../src/executor/index.js';
import { startServers, type StubServers } from '../fixture-page/server.js';

/**
 * The command end-to-end: our CDP dispatch, in a real browser, proven trusted.
 *
 * The unit suite asserts the exact protocol commands the executor builds against a fake dispatcher.
 * This closes the loop: it drives those same commands — through {@link createDebuggerDispatcher},
 * the identical adapter the extension's worker uses — over a real Chromium's DevTools protocol, and
 * checks that the application saw a *trusted* click and *trusted* keystrokes. `isTrusted` is the
 * whole reason docs/ARCHITECTURE.md § 3 mandates CDP over synthetic events: an approve button may
 * refuse a synthetic click, and this is where we prove ours is not synthetic.
 *
 * It loads no extension — the executor needs a live `Element` and `window`, which live in the page,
 * not in this Node process, so the honest e2e is to exercise the command path directly rather than
 * fake the whole voice → resolve → speculate pipeline in a headless browser.
 */

let servers: StubServers;
let browser: Browser;
let page: Page;
let session: CDPSession;
let send: SendCommand;

beforeAll(async () => {
  servers = await startServers();
  // System Chromium, as the HUD e2e uses: the bundled Playwright browser is the headless shell,
  // whose Input domain support this test cannot rely on. `channel: 'chromium'` selects the full one.
  browser = await chromium.launch({ channel: 'chromium' });
  page = await browser.newPage();
  await page.goto(servers.pageUrl);
  session = await page.context().newCDPSession(page);
  // CDPSession.send is keyed by method literal; the executor calls it with a plain string, so the
  // transport is adapted to the permissive SendCommand shape once, here.
  const rawSend = session.send.bind(session) as (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  send = (method, params) => rawSend(method, params);
}, 120_000);

afterAll(async () => {
  await browser.close();
  await servers.close();
});

/** The centre of an element in viewport pixels — the same point `viewportPoint` computes. */
async function centre(selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

describe('a click dispatched through the CDP executor', () => {
  it('reaches the application as a trusted event', async () => {
    const dispatcher = createDebuggerDispatcher(send);
    const { x, y } = await centre('#approve');

    // Exactly what ActionExecutor.click emits: a press then a release.
    await dispatcher.mouse({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await dispatcher.mouse({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });

    expect(await page.locator('#log').textContent()).toBe('approve clicked');
    // The point of the whole approach: the click was trusted, not synthetic.
    expect(await page.locator('html').getAttribute('data-trusted')).toBe('true');
  });
});

describe('typing dispatched through the CDP executor', () => {
  it('enters trusted keystrokes into the field', async () => {
    const dispatcher = createDebuggerDispatcher(send);
    await page.locator('#search').focus();

    // Exactly what ActionExecutor.typeText emits: a down/up pair per character.
    for (const char of 'hi') {
      for (const event of keyEventsForChar(char)) await dispatcher.key(event);
    }

    expect(await page.locator('#search').inputValue()).toBe('hi');
    expect(await page.locator('html').getAttribute('data-typed-trusted')).toBe('true');
  });
});
