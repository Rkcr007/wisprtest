import { describe, expect, it, vi } from 'vitest';

import { Lifecycle, installSignalHandlers } from './lifecycle.js';

describe('Lifecycle', () => {
  it('drains hooks in reverse registration order', async () => {
    const lifecycle = new Lifecycle();
    const order: string[] = [];

    lifecycle.onShutdown('database', () => {
      order.push('database');
    });
    lifecycle.onShutdown('http-server', () => {
      order.push('http-server');
    });

    await lifecycle.shutdown('SIGTERM');

    expect(order).toEqual(['http-server', 'database']);
  });

  it('runs every hook exactly once when a second signal arrives mid-drain', async () => {
    const lifecycle = new Lifecycle();
    const hook = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    lifecycle.onShutdown('slow-close', hook);

    const first = lifecycle.shutdown('SIGTERM');
    const second = lifecycle.shutdown('SIGINT');

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(hook).toHaveBeenCalledTimes(1);
    expect(firstResult).toBe(secondResult);
    expect(firstResult.signal).toBe('SIGTERM');
  });

  it('continues draining after a hook throws and reports the failure', async () => {
    const lifecycle = new Lifecycle();
    const survivor = vi.fn();

    lifecycle.onShutdown('database', survivor);
    lifecycle.onShutdown('http-server', () => {
      throw new Error('socket already closed');
    });

    const result = await lifecycle.shutdown('SIGTERM');

    expect(survivor).toHaveBeenCalledTimes(1);
    expect(result.failures.map((failure) => failure.name)).toEqual(['http-server']);
  });

  it('reports no failures and a measured duration on a clean drain', async () => {
    const lifecycle = new Lifecycle();
    lifecycle.onShutdown('noop', () => undefined);

    const result = await lifecycle.shutdown('SIGTERM');

    expect(result.failures).toHaveLength(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('exposes whether a drain is in flight', async () => {
    const lifecycle = new Lifecycle();

    expect(lifecycle.isShuttingDown).toBe(false);
    const drain = lifecycle.shutdown('SIGTERM');
    expect(lifecycle.isShuttingDown).toBe(true);

    await drain;
  });
});

describe('installSignalHandlers', () => {
  it('drains on signal and removes its listeners on uninstall', async () => {
    const lifecycle = new Lifecycle();
    const closed = vi.fn();
    lifecycle.onShutdown('http-server', closed);

    const listeners = new Map<string, () => void>();
    const fakeProcess = {
      on: vi.fn((signal: string, listener: () => void) => {
        listeners.set(signal, listener);
      }),
      off: vi.fn((signal: string) => {
        listeners.delete(signal);
      }),
    };

    const uninstall = installSignalHandlers({
      lifecycle,
      signals: ['SIGTERM', 'SIGINT'],
      process: fakeProcess as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
      onShutdown: vi.fn(),
    });

    expect(listeners.size).toBe(2);

    listeners.get('SIGTERM')?.();
    await lifecycle.shutdown('SIGTERM');

    expect(closed).toHaveBeenCalledTimes(1);

    uninstall();
    expect(listeners.size).toBe(0);
  });
});
