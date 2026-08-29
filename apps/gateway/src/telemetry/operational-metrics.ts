import type { ApplicationOperationalMetric, OperationalMetricState } from './metrics.js';

const REFRESH_INTERVAL_MS = 30_000;

interface OperationalMetricsLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface OperationalMetricsRefresh {
  /** Refresh immediately. Concurrent callers share the same database read. */
  refresh(): Promise<void>;
  /** Stop future refreshes and wait for an in-flight read to settle. */
  stop(): Promise<void>;
}

export interface StartOperationalMetricsOptions {
  readonly read: () => Promise<readonly ApplicationOperationalMetric[]>;
  readonly state: OperationalMetricState;
  readonly logger: OperationalMetricsLogger;
  readonly intervalMs?: number;
}

/**
 * Keep synchronous observable-gauge state aligned with fleet truth in Postgres.
 *
 * OTel observable callbacks are synchronous, so they must not query the database. This loop does
 * the asynchronous work outside collection and atomically swaps the complete snapshot. A failed
 * refresh keeps the last known values and logs the failure; readiness remains responsible for
 * reporting database availability.
 */
export function startOperationalMetricsRefresh(
  options: StartOperationalMetricsOptions,
): OperationalMetricsRefresh {
  const intervalMs = options.intervalMs ?? REFRESH_INTERVAL_MS;
  let inFlight: Promise<void> | undefined;
  let stopped = false;

  const refresh = (): Promise<void> => {
    if (inFlight !== undefined) return inFlight;

    inFlight = options
      .read()
      .then((values) => {
        if (!stopped) options.state.replace(values);
      })
      .catch((error: unknown) => {
        options.logger.warn(
          { event: 'operational_metrics.refresh_failed', err: error },
          'operational metrics could not be refreshed; retaining the last complete snapshot',
        );
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  const timer = setInterval(() => {
    void refresh();
  }, intervalMs);
  timer.unref();

  return {
    refresh,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
