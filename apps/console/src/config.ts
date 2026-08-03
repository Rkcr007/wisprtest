import { z } from 'zod';

/**
 * Console server configuration, validated when the Next server boots (see instrumentation.ts).
 * No defaults: CLAUDE.md rule #10 requires a loud failure over a silent fallback.
 *
 * ## Why the console holds OIDC client credentials
 *
 * ARCHITECTURE § 8: "OIDC for console". Every gateway route the console calls is authenticated
 * with a bearer token minted by the tenant's identity provider, and the gateway verifies the
 * issuer, the audience and the signature on each one. The console is therefore an OIDC
 * *relying party*: it runs the authorization-code flow, holds the resulting access token in an
 * encrypted, HTTP-only cookie, and attaches it server-side. The browser never sees the token.
 *
 * `OIDC_CLIENT_SECRET` is optional because a browser-facing client registered as *public* has
 * none — PKCE is what protects the exchange, and RFC 7636 is explicit that a confidential
 * secret adds nothing for a client that cannot keep one. The console is a server, so it can, and
 * it will use one when the deployment issues one.
 */
const consoleEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  CONSOLE_PORT: z.coerce.number().int().positive().max(65535),

  // ── The gateway ────────────────────────────────────────────────────────────────────────────
  /**
   * Where the gateway is reachable from the console *server*. Never sent to the browser: every
   * call the console makes is server-side, so the gateway needs no CORS policy for this origin
   * and the browser learns nothing about the control plane's topology.
   */
  GATEWAY_URL: z.url({ protocol: /^https?$/ }),

  // ── Authentication ─────────────────────────────────────────────────────────────────────────
  /** Same issuer the gateway verifies `iss` against, or the tokens this console mints are junk. */
  OIDC_ISSUER_URL: z.url({ protocol: /^https?$/ }),
  /** Same audience the gateway verifies `aud` against, for the same reason. */
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_CLIENT_ID: z.string().min(1),
  /** Absent means a public client: PKCE alone protects the code exchange. */
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  /** Must be registered with the provider exactly. `${CONSOLE_URL}/auth/callback`. */
  OIDC_REDIRECT_URI: z.url({ protocol: /^https?$/ }),

  /**
   * Key for the encrypted session cookie, at least 32 characters.
   *
   * The cookie holds a live access token for the gateway, so it is encrypted rather than merely
   * signed — a signed cookie is readable by anyone holding it, and "readable" here means the
   * tenant's bearer token in plaintext in a browser jar.
   */
  CONSOLE_SESSION_SECRET: z.string().min(32),
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

/**
 * The validated configuration, parsed once per server process.
 *
 * Request handlers read this rather than `process.env`: a typo in a variable name then fails at
 * boot with a named issue instead of arriving as `undefined` in a fetch URL.
 */
let cached: ConsoleConfig | undefined;

export function config(): ConsoleConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test seam: drops the memoised configuration so a suite can vary the environment. */
export function resetConfigCache(): void {
  cached = undefined;
}
