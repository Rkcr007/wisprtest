import { describe, expect, it, vi } from 'vitest';

import { createOperationalMetricState, type ApplicationOperationalMetric } from './metrics.js';
import { startOperationalMetricsRefresh } from './operational-metrics.js';

const VALUES: readonly ApplicationOperationalMetric[] = [
  {
    tenantId: '11111111-1111-4111-8111-111111111111',
    applicationId: '33333333-3333-4333-8333-333333333331',
    openDriftCount: 3,
    memoryStalenessHours: 12.5,
  },
];

describe('startOperationalMetricsRefresh', () => {
  it('atomically publishes a completed database snapshot', async () => {
    const state = createOperationalMetricState();
    const refresh = startOperationalMetricsRefresh({
      read: () => Promise.resolve(VALUES),
      state,
      logger: { warn: vi.fn() },
      intervalMs: 60_000,
    });

    await refresh.refresh();

    expect(state.read()).toEqual(VALUES);
    await refresh.stop();
  });

  it('shares concurrent refreshes rather than multiplying fleet queries', async () => {
    let release: ((values: readonly ApplicationOperationalMetric[]) => void) | undefined;
    const read = vi.fn(
      () =>
        new Promise<readonly ApplicationOperationalMetric[]>((resolve) => {
          release = resolve;
        }),
    );
    const refresh = startOperationalMetricsRefresh({
      read,
      state: createOperationalMetricState(),
      logger: { warn: vi.fn() },
      intervalMs: 60_000,
    });

    const first = refresh.refresh();
    const second = refresh.refresh();
    release?.(VALUES);
    await Promise.all([first, second]);

    expect(read).toHaveBeenCalledTimes(1);
    await refresh.stop();
  });

  it('retains the last complete snapshot and logs a failed refresh', async () => {
    const state = createOperationalMetricState();
    state.replace(VALUES);
    const warn = vi.fn();
    const refresh = startOperationalMetricsRefresh({
      read: () => Promise.reject(new Error('database unavailable')),
      state,
      logger: { warn },
      intervalMs: 60_000,
    });

    await refresh.refresh();

    expect(state.read()).toEqual(VALUES);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ event: 'operational_metrics.refresh_failed' }),
      'operational metrics could not be refreshed; retaining the last complete snapshot',
    );
    await refresh.stop();
  });
});
