import { describe, expect, it, vi } from 'vitest';

import { Lifecycle, installSignalHandlers } from './lifecycle.js';

describe('Lifecycle', () => {
  it('drains hooks in reverse registration order', async () => {
    const lifecycle = new Lifecycle();
    const order: string[] = [];

    lifecycle.onShutdown('browser-context', () => {
      order.push('browser-context');
    });
    lifecycle.onShutdown('job-consumer', () => {
      order.push('job-consumer');
    });

    await lifecycle.shutdown('SIGTERM');

    expect(order).toEqual(['job-consumer', 'browser-context']);
  });

  it('runs every hook exactly once when a second signal arrives mid-drain', async () => {
    const lifecycle = new Lifecycle();
    const hook = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    lifecycle.onShutdown('slow-close', hook);

    const [first, second] = await Promise.all([
      lifecycle.shutdown('SIGTERM'),
      lifecycle.shutdown('SIGINT'),
    ]);

    expect(hook).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first.signal).toBe('SIGTERM');
  });

  it('continues draining after a hook throws and reports the failure', async () => {
    const lifecycle = new Lifecycle();
    const survivor = vi.fn();

    lifecycle.onShutdown('browser-context', survivor);
    lifecycle.onShutdown('job-consumer', () => {
      throw new Error('stream connection lost');
    });

    const result = await lifecycle.shutdown('SIGTERM');

    expect(survivor).toHaveBeenCalledTimes(1);
    expect(result.failures.map((failure) => failure.name)).toEqual(['job-consumer']);
  });
});

describe('installSignalHandlers', () => {
  it('drains on signal and removes its listeners on uninstall', async () => {
    const lifecycle = new Lifecycle();
    const closed = vi.fn();
    lifecycle.onShutdown('job-consumer', closed);

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
