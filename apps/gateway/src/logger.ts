import { pino, type DestinationStream, type Logger } from 'pino';

import { currentContext } from './context/request-context.js';

export interface LoggerOptions {
  /** Service name, carried on every line so a shared log sink stays queryable. */
  readonly service: string;
  readonly level: string;
  readonly env: string;
}

/**
 * Keys whose values are, or may contain, content from the application under test.
 *
 * CLAUDE.md § "Conventions": "Never log element text content — it may contain PII." The PII
 * rule is a procurement blocker, and a log sink is exactly the place a customer's data ends up
 * by accident — one `logger.info({ element })` in a debugging session is all it takes, and the
 * line is then in a retained index nobody remembers to purge.
 *
 * Redaction is by key rather than by value inspection. Value inspection cannot tell a
 * customer's name from a button label, so it would either miss real PII or mangle ordinary
 * fields; a key list is blunt, but it is auditable and it fails in the safe direction.
 *
 * The wildcards cover nesting: `element.accessibleName`, `candidates[0].label`, and so on.
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
  // Request headers are logged by Fastify's own serialisers; the bearer token must not be.
  paths.push('req.headers.authorization', 'req.headers.cookie', 'headers.authorization');
  return paths;
}

/**
 * Structured JSON logger.
 *
 * `tenant_id`, `session_id` and `trace_id` are required on every line by CLAUDE.md
 * § "Conventions". They are request-scoped, so rather than asking every call site to remember
 * them, a mixin reads them from the ambient request context — which means a line emitted deep
 * inside a repository carries the same correlation fields as one emitted in the handler, with
 * nothing threaded through in between.
 *
 * Outside a request — during boot, or in a background job — the fields are simply absent rather
 * than null. A permanently empty field teaches nobody anything, and its absence is itself
 * information: this line did not happen while serving anybody.
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
      mixin: () => {
        const context = currentContext();
        if (context === undefined) return {};
        return {
          tenant_id: context.tenantId,
          session_id: context.sessionId,
          trace_id: context.traceId,
          request_id: context.requestId,
          user_id: context.userId,
        };
      },
      redact: { paths: redactionPaths(), censor: '[redacted]' },
    },
    destination,
  );
}

/** The keys the redaction serialiser masks. Exported so the test can assert the list itself. */
export const REDACTED_LOG_KEYS: readonly string[] = REDACTED_KEYS;
