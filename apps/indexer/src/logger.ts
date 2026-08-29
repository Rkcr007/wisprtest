import { pino, type DestinationStream, type Logger } from 'pino';

export interface LoggerOptions {
  readonly service: string;
  readonly level: string;
  readonly env: string;
  /** Identifies which worker produced a line once several run against one job stream. */
  readonly workerId: string;
}

/**
 * Keys that can carry customer content or credentials into an indexer log.
 *
 * Redaction happens in the sink rather than at call sites so temporary diagnostic logging cannot
 * bypass it. Wildcard paths cover nested elements, candidates, payloads and captured exchanges.
 */
const REDACTED_KEYS = [
  'accessibleName',
  'accessibleNameRedacted',
  'label',
  'targetPhrase',
  'utterance',
  'phrase',
  'text',
  'textContent',
  'value',
  'payload',
  'password',
  'token',
  'authorization',
] as const;

function redactionPaths(): string[] {
  const paths: string[] = [];
  for (const key of REDACTED_KEYS) {
    paths.push(key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`);
  }
  paths.push('req.headers.authorization', 'req.headers.cookie', 'headers.authorization');
  return paths;
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
      redact: { paths: redactionPaths(), censor: '[redacted]' },
    },
    destination,
  );
}

/** Auditable list of fields the indexer log sink censors. */
export const REDACTED_LOG_KEYS: readonly string[] = REDACTED_KEYS;
