import { pino } from 'pino';

import { loadConfig } from './config';

/**
 * Node.js-runtime bootstrap: validates the environment and emits the console's single
 * structured startup line, matching the JSON shape the other services use so one log sink can
 * query all of them.
 *
 * Next installs its own SIGTERM/SIGINT handling and drains in-flight requests on shutdown, so
 * the console registers no signal handlers of its own.
 *
 * CLAUDE.md § "Conventions" requires `tenant_id`, `session_id` and `trace_id` on every line.
 * Those are request-scoped; Phase 18 binds them onto a per-request child logger.
 */
export function start(): void {
  const config = loadConfig();

  const logger = pino({
    level: config.LOG_LEVEL,
    base: { service: 'console', env: config.NODE_ENV },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: { level: (label) => ({ level: label }) },
  });

  logger.info(
    { event: 'service.started', port: config.CONSOLE_PORT, pid: process.pid },
    'console started',
  );
}
