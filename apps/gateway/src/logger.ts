import { pino, type DestinationStream, type Logger } from 'pino';

export interface LoggerOptions {
  /** Service name, carried on every line so a shared log sink stays queryable. */
  readonly service: string;
  readonly level: string;
  readonly env: string;
}

/**
 * Structured JSON logger.
 *
 * CLAUDE.md § "Conventions" requires `tenant_id`, `session_id` and `trace_id` on every line.
 * Those are request-scoped and the gateway has no requests until Phase 4, which binds them
 * from AsyncLocalStorage into a child logger. Emitting them as nulls now would put three
 * permanently empty fields in every line and teach nobody anything, so the base context here
 * is limited to what this phase genuinely knows.
 */
export function createLogger(options: LoggerOptions, destination?: DestinationStream): Logger {
  return pino(
    {
      level: options.level,
      base: { service: options.service, env: options.env },
      // ISO 8601 in UTC at the boundary, per CLAUDE.md § "Conventions".
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      formatters: {
        level: (label) => ({ level: label }),
      },
    },
    destination,
  );
}
