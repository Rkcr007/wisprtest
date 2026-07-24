/**
 * Structured logging for the extension.
 *
 * The Node services use pino, which is not usable in an MV3 service worker: it targets Node
 * streams and would drag Node built-ins into the bundle. This emits the same JSON line shape
 * — `level`, `time` (ISO 8601 UTC), `service`, `env`, plus caller fields — so extension logs
 * and service logs stay queryable together in one sink.
 *
 * CLAUDE.md § "Conventions": element text content is never logged, because it may contain PII.
 * Fields are typed to primitives so a DOM node or accessible name cannot be passed by accident.
 */

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug';

export type LogValue = string | number | boolean | null;

export interface LogContext {
  readonly service: string;
  readonly env: string;
}

export type LogSink = (line: string) => void;

export function formatLine(
  context: LogContext,
  level: LogLevel,
  event: string,
  fields: Readonly<Record<string, LogValue>>,
  msg: string,
  now: Date = new Date(),
): string {
  // Caller fields are spread first so a reserved key can never be overwritten: a log line whose
  // `level` or `service` is attacker- or bug-supplied is worse than a dropped field.
  return JSON.stringify({
    ...fields,
    level,
    time: now.toISOString(),
    service: context.service,
    env: context.env,
    event,
    msg,
  });
}

export interface ExtensionLogger {
  log: (
    level: LogLevel,
    event: string,
    fields: Readonly<Record<string, LogValue>>,
    msg: string,
  ) => void;
}

export function createLogger(context: LogContext, sink: LogSink): ExtensionLogger {
  return {
    log: (level, event, fields, msg) => {
      sink(formatLine(context, level, event, fields, msg));
    },
  };
}

/** Default sink: one JSON line per call, readable in the service worker's devtools console. */
export const consoleSink: LogSink = (line) => {
  console.log(line);
};
