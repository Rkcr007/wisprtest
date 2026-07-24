import { z } from 'zod';

import { ConfigError } from './errors.js';

/**
 * Indexer configuration. No defaults — CLAUDE.md rule #10 requires a loud boot failure over a
 * silent fallback. `INDEXER_WORKER_ID` has to be explicit: it becomes this worker's identity
 * in the Redis consumer group in Phase 5, and two workers silently sharing a generated default
 * would double-process crawl jobs.
 */
const indexerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  INDEXER_WORKER_ID: z.string().min(1),
});

export type IndexerConfig = z.infer<typeof indexerEnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const result = indexerEnvSchema.safeParse(env);

  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const variable = issue.path.map(String).join('.');
        return variable === '' ? issue.message : `${variable}: ${issue.message}`;
      }),
    );
  }

  return result.data;
}
