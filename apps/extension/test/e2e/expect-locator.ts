import type { Locator } from 'playwright';

/**
 * Retrying assertions for Playwright locators, under vitest's `expect`.
 *
 * `@playwright/test` ships matchers that poll — `toHaveAttribute`, `toHaveText` — but that is a
 * whole second test runner, and this repository already runs vitest everywhere. These four
 * helpers are the ones this suite needs.
 *
 * Polling is not optional here. Attaching is asynchronous end to end: the content script posts to
 * the service worker, the worker fetches a token over HTTP, and the answer comes back down a
 * port. Reading an attribute once, immediately, would test how fast the machine is.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_MS = 50;

async function until<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  describe: (value: T) => string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await read();

  while (Date.now() < deadline) {
    if (matches(last)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    last = await read();
  }

  if (matches(last)) return;
  throw new Error(`${describe(last)} (waited ${String(timeoutMs)}ms)`);
}

export function expectAttribute(
  locator: Locator,
  name: string,
  value: string,
  timeoutMs?: number,
): Promise<void> {
  return until(
    () => locator.getAttribute(name),
    (actual) => actual === value,
    (actual) => `expected ${name}="${value}", got ${name}="${String(actual)}"`,
    timeoutMs,
  );
}

export function expectCount(locator: Locator, count: number, timeoutMs?: number): Promise<void> {
  return until(
    () => locator.count(),
    (actual) => actual === count,
    (actual) => `expected ${String(count)} matching elements, found ${String(actual)}`,
    timeoutMs,
  );
}

export function expectText(locator: Locator, text: string, timeoutMs?: number): Promise<void> {
  return until(
    () => locator.textContent(),
    (actual) => (actual ?? '').trim() === text,
    (actual) => `expected text "${text}", got "${String(actual)}"`,
    timeoutMs,
  );
}

export function expectContainsText(
  locator: Locator,
  text: string,
  timeoutMs?: number,
): Promise<void> {
  return until(
    () => locator.textContent(),
    (actual) => (actual ?? '').includes(text),
    (actual) => `expected text containing "${text}", got "${String(actual)}"`,
    timeoutMs,
  );
}
