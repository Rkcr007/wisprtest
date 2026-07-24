import { z } from 'zod';

/**
 * Console server configuration, validated when the Next server boots (see instrumentation.ts).
 * No defaults: CLAUDE.md rule #10 requires a loud failure over a silent fallback.
 */
const consoleEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  CONSOLE_PORT: z.coerce.number().int().positive().max(65535),
});

export type ConsoleConfig = z.infer<typeof consoleEnvSchema>;

export class ConfigError extends Error {
  readonly code = 'config_invalid' as const;
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid console configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConsoleConfig {
  const result = consoleEnvSchema.safeParse(env);

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
