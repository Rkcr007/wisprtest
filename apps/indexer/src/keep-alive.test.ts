import { describe, expect, it } from 'vitest';

import { holdEventLoop } from './keep-alive.js';

describe('holdEventLoop', () => {
  it('holds a handle until released', () => {
    const keepAlive = holdEventLoop();

    expect(keepAlive.isHeld).toBe(true);

    keepAlive.release();
    expect(keepAlive.isHeld).toBe(false);
  });

  it('is safe to release more than once', () => {
    const keepAlive = holdEventLoop();

    keepAlive.release();
    keepAlive.release();

    expect(keepAlive.isHeld).toBe(false);
  });

  it('keeps the process referenced while held', () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const keepAlive = holdEventLoop();
    const during = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

    expect(during).toBeGreaterThan(before);

    keepAlive.release();
  });
});
