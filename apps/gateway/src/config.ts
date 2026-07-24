import { z } from 'zod';

import { ConfigError } from './errors.js';

/**
 * Gateway configuration, read from the process environment and validated at boot.
 *
 * Nothing here has a fallback. CLAUDE.md rule #10 requires boot to fail loudly on missing
 * config rather than defaulting: a gateway that silently binds the wrong port or runs with
 * the wrong `NODE_ENV` is worse than one that refuses to start.
 */
const gatewayEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  GATEWAY_HOST: z.string().min(1),
  GATEWAY_PORT: z.coerce.number().int().positive().max(65535),
});

export type GatewayConfig = z.infer<typeof gatewayEnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const result = gatewayEnvSchema.safeParse(env);

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
