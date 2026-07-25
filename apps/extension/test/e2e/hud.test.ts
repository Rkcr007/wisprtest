import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServers, type StubServers } from '../fixture-page/server.js';
import { expectAttribute, expectContainsText, expectCount, expectText } from './expect-locator.js';

/**
 * The extension, loaded unpacked into a real Chromium, on a real page.
 *
 * The unit suite proves each piece in isolation; this proves the pieces are wired to each other
 * and that the result behaves in an actual browser — a shadow root that really isolates, a drag
 * that really moves the panel, and a page that really still works underneath it.
 *
 * Playwright pierces open shadow roots with ordinary CSS selectors, which is one of the reasons
 * the root is open. See `src/content/mount.ts`.
 */

const EXTENSION_DIR = fileURLToPath(new URL('../../dist', import.meta.url));

let servers: StubServers;
let context: BrowserContext;
let profileDir: string;
let page: Page;

beforeAll(async () => {
  servers = await startServers();
  profileDir = await mkdtemp(join(tmpdir(), 'wispr-ext-'));

  // Extensions require a persistent context — there is no way to load one into an ephemeral
  // browser. The profile is a temporary directory, so runs cannot inherit each other's state.
  //
  // `channel: 'chromium'` is load-bearing: Playwright's default bundled browser is the headless
  // *shell*, which does not run extensions at all — the page loads, nothing is injected, and the
  // suite times out waiting for a HUD that was never going to appear. The channel selects the
  // full Chromium, whose new headless mode supports them.
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });

  page = await context.newPage();
  await page.goto(servers.pageUrl);
  await page.locator('wispr-test-hud [data-testid="wispr-hud"]').waitFor();
}, 120_000);

afterAll(async () => {
  await context.close();
  await servers.close();
  await rm(profileDir, { recursive: true, force: true });
});

const hud = () => page.locator('wispr-test-hud [data-testid="wispr-hud"]');

describe('mounting', () => {
  it('renders the HUD inside a shadow root, collapsed', async () => {
    await expectCount(hud(), 1);
    await expectAttribute(hud(), 'data-collapsed', 'true');

    // Not a light-DOM child of the page: the panel lives behind a shadow boundary.
    const inShadow = await page.evaluate(() => {
      const host = document.querySelector('wispr-test-hud');
      return host?.shadowRoot?.querySelector('[data-testid="wispr-hud"]') !== null;
    });
    expect(inShadow).toBe(true);
  });

  it('leaves the page exactly as it found it', async () => {
    const state = await page.evaluate(() => ({
      bodyStyleAttribute: document.body.getAttribute('style'),
      bodyMargin: getComputedStyle(document.body).margin,
      bodyChildTags: [...document.body.children].map((child) => child.tagName),
      styleSheetCount: document.styleSheets.length,
      headStyleCount: document.head.querySelectorAll('style').length,
    }));

    // The application's own layout, untouched: its margin, its children, its stylesheet count.
    expect(state.bodyStyleAttribute).toBeNull();
    expect(state.bodyMargin).toBe('40px');
    expect(state.bodyChildTags).toEqual(['HEADER', 'MAIN', 'SCRIPT']);
    // One stylesheet — the page's own. The HUD's is adopted into the shadow root.
    expect(state.styleSheetCount).toBe(1);
    expect(state.headStyleCount).toBe(1);
  });

  it('adds one node, outside the body', async () => {
    const placement = await page.evaluate(() => ({
      hostsInDocument: document.querySelectorAll('wispr-test-hud').length,
      hostInBody: document.body.querySelector('wispr-test-hud') !== null,
      parentTag: document.querySelector('wispr-test-hud')?.parentElement?.tagName,
    }));

    expect(placement.hostsInDocument).toBe(1);
    expect(placement.hostInBody).toBe(false);
    expect(placement.parentTag).toBe('HTML');
  });

  it('does not take focus from the application', async () => {
    await page.locator('#approve').focus();

    expect(await page.evaluate(() => document.activeElement?.id)).toBe('approve');
  });

  it('lets clicks outside the panel reach the page', async () => {
    // The HUD's container spans the viewport so the panel can be dragged anywhere in it. If it
    // swallowed clicks, the application would be untestable — with a testing tool attached.
    await page.locator('#approve').click();

    await expectText(page.locator('#log'), 'approve clicked');
  });
});

describe('attaching', () => {
  it('goes through attaching to attached, and mints exactly one token', async () => {
    await expectAttribute(hud(), 'data-attach', 'detached');

    await page.locator('[data-testid="wispr-hud-attach"]').click();
    await expectAttribute(hud(), 'data-attach', 'attached');

    // The exchange really happened, against the origin the content script is running on.
    expect(servers.tokenRequests).toHaveLength(1);
    expect(servers.tokenRequests[0]?.origin).toBe(`http://127.0.0.1:4320`);
  });

  it('shows what it is attached to, and no invented measurements', async () => {
    await page.locator('[data-testid="wispr-hud-collapse"]').click();
    await expectAttribute(hud(), 'data-collapsed', 'false');

    const telemetry = page.locator('[data-testid="wispr-hud-telemetry"]');
    await expectContainsText(telemetry, 'Attached');
    await expectContainsText(telemetry, 'valid');

    // Tier, resolve latency and step count belong to later phases and say so.
    await expectCount(telemetry.locator('[aria-label="no data yet"]'), 3);
  });

  it('never exposes the token to the page', async () => {
    // The page can reach into an open shadow root. There is still nothing there to take: the
    // token stays in the service worker and only its *state* is sent to the content script.
    const leaked = await page.evaluate(() => {
      const host = document.querySelector('wispr-test-hud');
      return (host?.shadowRoot?.textContent ?? '').includes('e2e.scoped.token');
    });

    expect(leaked).toBe(false);
  });

  it('detaches again', async () => {
    await page.locator('[data-testid="wispr-hud-attach"]').click();

    await expectAttribute(hud(), 'data-attach', 'detached');
  });
});

describe('dragging', () => {
  it('moves with the grip and snaps to an edge on release', async () => {
    const grip = page.locator('[data-testid="wispr-hud-grip"]');
    const before = await hud().evaluate((node) => node.style.transform);

    const box = await grip.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) throw new Error('unreachable');

    const viewport = page.viewportSize();
    if (viewport === null) throw new Error('the persistent context has no viewport');

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Two moves: one to start the drag, one to land it near the right edge.
    await page.mouse.move(viewport.width / 2, 300, { steps: 8 });
    await page.mouse.move(viewport.width - 40, 300, { steps: 8 });
    await page.mouse.up();

    const after = await hud().evaluate((node) => node.style.transform);
    expect(after).not.toBe(before);

    // Released within the magnet threshold of the right edge, so it should be flush against it.
    const geometry = await hud().evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { right: Math.round(window.innerWidth - rect.right), width: Math.round(rect.width) };
    });
    expect(geometry.right).toBe(12);
  });

  it('moves by keyboard, so the panel is not mouse-only', async () => {
    const grip = page.locator('[data-testid="wispr-hud-grip"]');
    await grip.focus();
    const before = await hud().evaluate((node) => node.getBoundingClientRect().top);

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');

    const after = await hud().evaluate((node) => node.getBoundingClientRect().top);
    expect(after).toBeGreaterThan(before);
  });
});

describe('collapsing', () => {
  it('hides the intent and telemetry bands', async () => {
    const collapse = page.locator('[data-testid="wispr-hud-collapse"]');

    if ((await hud().getAttribute('data-collapsed')) === 'false') await collapse.click();
    await expectCount(page.locator('[data-testid="wispr-hud-intent"]'), 0);

    await collapse.click();
    await expectCount(page.locator('[data-testid="wispr-hud-intent"]'), 1);
    await expectCount(page.locator('[data-testid="wispr-hud-telemetry"]'), 1);
  });
});

describe('when the gateway rejects the session', () => {
  it('fails closed, and says what to do about it', async () => {
    servers.setUnauthenticated(true);

    // A second origin, which has never had a token minted for it: the first one's token is
    // cached, and reusing it would test the cache rather than the failure.
    const fresh = await context.newPage();
    await fresh.goto(servers.altPageUrl);
    await fresh.locator('wispr-test-hud [data-testid="wispr-hud"]').waitFor();
    await fresh.locator('[data-testid="wispr-hud-attach"]').click();

    const panel = fresh.locator('wispr-test-hud [data-testid="wispr-hud"]');
    await expectAttribute(panel, 'data-attach', 'failed');

    // Not an eternal "attaching…": the tester is told to sign in, and can try again.
    if ((await panel.getAttribute('data-collapsed')) === 'true') {
      await fresh.locator('[data-testid="wispr-hud-collapse"]').click();
    }
    await expectContainsText(fresh.locator('[data-testid="wispr-toast"]'), 'Sign in');

    servers.setUnauthenticated(false);
    await fresh.close();
  });
});
