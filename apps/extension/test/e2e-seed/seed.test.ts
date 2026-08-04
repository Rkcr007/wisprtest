import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WORKSPACE_ALIASES } from '../../src/build.js';
import { expectAttribute, expectContainsText, expectCount } from '../e2e/expect-locator.js';
import { SEED_GATEWAY_PORT, startSeedServers, type SeedServers } from './servers.js';

/**
 * The seeding loop, end to end (docs/BUILD-PLAN.md Phase 15, `test:e2e:seed`).
 *
 * > "Test the full loop against the fixture app: utterance → plan → preview → approve →
 * > record exists → revert → record gone."
 *
 * Every step is the real thing on the extension's side. The intent detector decides the utterance
 * is a request for data; the controller composes; the card renders in a shadow root over a real
 * page; a real click approves it; the record appears in a real application and the mark is drawn
 * over the row that links to it; a real revert removes it.
 *
 * The two assertions that carry the most weight are the ones about what did *not* happen: a plan
 * that is never approved creates nothing, and an ordinary command never enters the seeding flow at
 * all. Those are CLAUDE.md § "Reversibility taxonomy" — class S is never speculative, never silent.
 */

let servers: SeedServers;
let browser: Browser;
let page: Page;

const GATEWAY_ORIGIN = `http://127.0.0.1:${String(SEED_GATEWAY_PORT)}`;

/** Bundle the harness with the same aliases the extension build uses, so it loads real modules. */
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
      __WISPR_SEED_GATEWAY__: JSON.stringify(GATEWAY_ORIGIN),
    },
    logLevel: 'warning',
  });
  return result.outputFiles[0]?.text ?? '';
}

/**
 * The card, reached through the shadow root the way a tester's click reaches it.
 *
 * Playwright's CSS engine pierces open shadow roots on its own, so this needs no special syntax —
 * and the click that lands really does traverse the boundary, which is the point.
 */
function card(testId: string): Locator {
  return page.locator(`[data-testid="${testId}"]`);
}

/** Load the application fresh, with the harness mounted and ready. */
async function loadApp(): Promise<void> {
  await page.goto(servers.appUrl);
  await page.waitForFunction(() => document.documentElement.dataset.wisprSeedReady === 'true');
}

/** Say something, as the voice pipeline would deliver a final transcript. */
function speak(transcript: string): Promise<void> {
  return page.evaluate((text: string) => window.wisprSpeak(text), transcript);
}

/** The orders the application holds beyond the one it started with. */
function seeded(): readonly { externalRef: string; status: string; account: string }[] {
  return servers.orders().filter((order) => order.externalRef !== 'ORD-1001');
}

beforeAll(async () => {
  servers = await startSeedServers(await bundleHarness());
  // System Chromium, as the other end-to-end suites use.
  browser = await chromium.launch({ channel: 'chromium' });
  page = await browser.newPage();
  await loadApp();
}, 180_000);

/**
 * Each test starts against the application as it shipped: one record, no history.
 *
 * Without this a test asserting on "the record this test seeded" would be reading whichever record
 * an earlier test happened to leave behind — and would keep passing for the wrong reason.
 */
beforeEach(async () => {
  servers.reset();
  await loadApp();
});

afterAll(async () => {
  await browser.close();
  await servers.close();
});

describe('an utterance that is not a request for data', () => {
  it('never enters the seeding flow, and the gateway is never called', async () => {
    const before = servers.calls.length;

    await speak('approve the acme order');

    expect(await page.evaluate(() => window.wisprWasSeed())).toBe(false);
    expect(servers.calls.length).toBe(before);
    await expectCount(card('wispr-seed'), 0);
  });
});

describe('the full loop', () => {
  it('goes utterance → plan → preview → approve → record → revert → gone', async () => {
    expect(seeded()).toHaveLength(0);

    // ── utterance → plan ─────────────────────────────────────────────────────────────────
    await speak('I need a pending order for Acme with three line items');
    expect(await page.evaluate(() => window.wisprWasSeed())).toBe(true);

    // ── preview ──────────────────────────────────────────────────────────────────────────
    await expectAttribute(card('wispr-seed'), 'data-phase', 'previewing');
    await expectContainsText(card('wispr-seed-count'), '1 record');
    // Every field, with the reason it holds its value.
    await expectContainsText(card('wispr-seed-field-status'), 'Pending');
    await expectContainsText(card('wispr-seed-field-account'), 'matched from 64 known accounts');
    await expectContainsText(card('wispr-seed-field-amount'), 'sampled from 312 observed orders');
    // Which adapter will run, and whether it can be undone — both before anything is written.
    await expectContainsText(card('wispr-seed-adapter-order-1'), 'the real create form will run');
    await expectAttribute(card('wispr-seed-revert-order-1'), 'data-revertible', 'true');

    // Composing wrote nothing. This is the property `/v1/seed/plan` exists to have.
    expect(seeded()).toHaveLength(0);

    // ── approve → record exists ──────────────────────────────────────────────────────────
    await card('wispr-seed-approve').click();
    await expectAttribute(card('wispr-seed'), 'data-phase', 'executed');

    expect(seeded()).toHaveLength(1);
    expect(seeded()[0]?.status).toBe('Pending');
    expect(seeded()[0]?.account).toBe('Acme Industrial');

    const ref = seeded()[0]?.externalRef ?? '';
    await expectContainsText(card('wispr-seed-created'), ref);

    // The record is reachable in the application — the verification § 4 asks for.
    const origin = new URL(servers.appUrl).origin;
    expect((await page.request.get(`${origin}/orders/${ref}`)).status()).toBe(200);

    // ── revert → record gone ─────────────────────────────────────────────────────────────
    await card('wispr-seed-revert').click();
    await expectContainsText(card('wispr-seed-reverted'), 'reverted');

    expect(seeded()).toHaveLength(0);
    // The record the application started with is untouched: a revert undoes what we created.
    expect(servers.orders()).toHaveLength(1);
    expect((await page.request.get(`${origin}/orders/${ref}`)).status()).toBe(404);
  }, 120_000);
});

describe('a plan the tester does not approve', () => {
  it('creates nothing, and the card goes away', async () => {
    await speak('I need a pending order for Acme');
    await expectAttribute(card('wispr-seed'), 'data-phase', 'previewing');

    await card('wispr-seed-discard').click();

    await expectCount(card('wispr-seed'), 0);
    expect(seeded()).toHaveLength(0);
    // The gateway was asked to compose, and never asked to write.
    expect(servers.calls.filter((call) => call.path === '/v1/seed/execute')).toHaveLength(0);
  });
});

describe('one approval is one record', () => {
  it('cannot be turned into two by clicking twice', async () => {
    await speak('I need a pending order for Acme');
    await expectAttribute(card('wispr-seed'), 'data-phase', 'previewing');

    const approve = card('wispr-seed-approve');
    await approve.click();
    // The button is gone the moment the phase leaves `previewing`, so a second click has to be
    // forced through the DOM to prove the controller — not the rendering — is what holds the line.
    await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('[data-testid="wispr-seed-approve"]');
      button?.click();
      button?.click();
    });
    await expectAttribute(card('wispr-seed'), 'data-phase', 'executed');

    expect(seeded()).toHaveLength(1);
    expect(servers.calls.filter((call) => call.path === '/v1/seed/execute')).toHaveLength(1);

    await card('wispr-seed-revert').click();
    await expectContainsText(card('wispr-seed-reverted'), 'reverted');
  });
});

describe('the mark drawn over a created record', () => {
  it('appears over the row that links to it, and never blocks it', async () => {
    const listBefore = await page.locator('#orders').innerHTML();

    await speak('I need a pending order for Acme');
    await card('wispr-seed-approve').click();
    await expectAttribute(card('wispr-seed'), 'data-phase', 'executed');

    const ref = seeded()[0]?.externalRef ?? '';

    // The application's own DOM is exactly as it was: no class, no attribute, no inline style.
    // The record exists server-side, but this page's list was rendered before it did.
    expect(await page.locator('#orders').innerHTML()).toBe(listBefore);
    await expectCount(card(`wispr-seed-mark-${ref}`), 0);

    // Now the application refetches its list, the way a live one would after a create.
    await page.evaluate((externalRef: string) => {
      const row = document.createElement('li');
      row.className = 'row';
      row.innerHTML = `<a href="/orders/${externalRef}">Acme Industrial — Pending</a>`;
      document.querySelector('#orders')?.append(row);
      window.dispatchEvent(new Event('resize'));
    }, ref);

    const mark = card(`wispr-seed-mark-${ref}`);
    await expectCount(mark, 1);

    // Positioned over the row it names, and never in the way of clicking it.
    const rowBox = await page.locator(`#orders a[href="/orders/${ref}"]`).boundingBox();
    const markBox = await mark.boundingBox();
    expect(markBox?.x).toBeCloseTo(rowBox?.x ?? -1, 0);
    expect(markBox?.y).toBeCloseTo(rowBox?.y ?? -1, 0);
    expect(await mark.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe('none');

    await card('wispr-seed-revert').click();
    await expectContainsText(card('wispr-seed-reverted'), 'reverted');
    // Reverted records stop being marked: the outline claims the record exists.
    await expectCount(mark, 0);
  }, 120_000);
});

describe('a materialization that fails', () => {
  it('shows the chain and the concrete reason rather than a bare error', async () => {
    servers.failNextExecute('the create form rejected the amount field');

    await speak('I need a pending order for Acme');
    await card('wispr-seed-approve').click();

    await expectAttribute(card('wispr-seed'), 'data-phase', 'failed');
    // § 4 forbids silent degradation: the rung that ran and why it failed are both visible.
    await expectContainsText(card('wispr-seed-attempts'), 'the real form · failed');
    await expectContainsText(card('wispr-seed-error'), 'rejected the amount field');
    expect(seeded()).toHaveLength(0);
  });
});
