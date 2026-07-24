import { pino, type DestinationStream, type Logger } from 'pino';

export interface LoggerOptions {
  readonly service: string;
  readonly level: string;
  readonly env: string;
  /** Identifies which worker produced a line once several run against one job stream. */
  readonly workerId: string;
}

/**
 * Structured JSON logger. `tenant_id`, `session_id` and `trace_id` are job-scoped and are bound
 * onto a child logger per crawl job in Phase 5; this phase has no job to scope them to.
 */
export function createLogger(options: LoggerOptions, destination?: DestinationStream): Logger {
  return pino(
    {
      level: options.level,
      base: { service: options.service, env: options.env, worker_id: options.workerId },
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      formatters: {
        level: (label) => ({ level: label }),
      },
    },
    destination,
  );
}
