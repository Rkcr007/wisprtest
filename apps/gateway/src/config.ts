import { z } from 'zod';

import { ConfigError } from './errors.js';

/**
 * Gateway configuration, read from the process environment and validated at boot.
 *
 * Nothing here has a fallback. CLAUDE.md rule #10 requires boot to fail loudly on missing
 * config rather than defaulting: a gateway that silently binds the wrong port, connects to the
 * wrong database or trusts the wrong OIDC issuer is worse than one that refuses to start.
 *
 * Two variables are `.optional()`, and each is a stated decision rather than a silent default:
 * `OTEL_EXPORTER_OTLP_ENDPOINT` absent means "export nothing", which is the correct local
 * behaviour and is reported in the startup line; `OIDC_JWKS_URI` absent means "discover it from
 * the issuer", which is what the specification says to do.
 */
const gatewayEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  GATEWAY_HOST: z.string().min(1),
  GATEWAY_PORT: z.coerce.number().int().positive().max(65535),

  // ── Dependencies ───────────────────────────────────────────────────────────────────────────
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  QDRANT_URL: z.url({ protocol: /^https?$/ }),

  /** Upper bound on pooled connections. Sized against the server's `max_connections`. */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(1000),

  // ── Authentication ─────────────────────────────────────────────────────────────────────────
  /** Expected `iss`. A token from any other issuer is rejected before its signature is read. */
  OIDC_ISSUER_URL: z.url({ protocol: /^https?$/ }),
  /** Expected `aud`. A token minted for another service must not be accepted here. */
  OIDC_AUDIENCE: z.string().min(1),
  /**
   * JWKS location. Optional because the specification says to discover it from the issuer's
   * `/.well-known/openid-configuration`; set it to pin the endpoint and skip discovery.
   */
  OIDC_JWKS_URI: z.url({ protocol: /^https?$/ }).optional(),
  /** Leeway for clock skew between this service and the identity provider. */
  OIDC_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(300),

  // ── Rate limiting ──────────────────────────────────────────────────────────────────────────
  /** Requests permitted per tenant per window — per tenant, not per process. */
  RATE_LIMIT_MAX: z.coerce.number().int().min(1),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000),

  // ── T2 model provider ──────────────────────────────────────────────────────────────────────
  /**
   * API key for the T2 escalation model. Required: an escalate route with no key is a route that
   * cannot answer, which CLAUDE.md rule #1 forbids shipping as a live endpoint. Never logged.
   */
  MODEL_API_KEY: z.string().min(1),
  /** Base URL of the Anthropic Messages API. Overridable so a test can point at a local fake. */
  MODEL_BASE_URL: z.url({ protocol: /^https?$/ }),
  /** The small fast model tried first — Haiku class, per CLAUDE.md § "Resolution tiers". */
  MODEL_PRIMARY: z.string().min(1),
  /** The fallback model, used when the primary errors or times out. May equal the primary. */
  MODEL_FALLBACK: z.string().min(1),
  /**
   * Hard ceiling on a T2 call, per the phase: on timeout the route returns a typed error so the
   * extension falls back to disambiguation rather than hanging. Budgeted at 800 ms in CLAUDE.md.
   */
  MODEL_TIMEOUT_MS: z.coerce.number().int().min(1).max(5000),

  // ── Object storage — session evidence ──────────────────────────────────────────────────────
  /** S3-compatible endpoint. MinIO locally; managed object storage in production. */
  EVIDENCE_ENDPOINT: z.url({ protocol: /^https?$/ }),
  EVIDENCE_BUCKET: z.string().min(1),
  EVIDENCE_REGION: z.string().min(1),
  /** Never logged, and never sent to the console — which retrieves through signed URLs instead. */
  EVIDENCE_ACCESS_KEY_ID: z.string().min(1),
  EVIDENCE_SECRET_ACCESS_KEY: z.string().min(1),
  /**
   * Lifetime of a retrieval URL.
   *
   * Capped at an hour: these links point at screenshots of a customer's application and end up
   * pasted into bug reports. A long-lived one is a permanent unauthenticated view of that.
   */
  EVIDENCE_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600),

  // ── Observability ──────────────────────────────────────────────────────────────────────────
  OTEL_SERVICE_NAME: z.string().min(1),
  /** Absent means export nothing: the right local default, and it is logged at boot. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),

  // ── Shutdown ───────────────────────────────────────────────────────────────────────────────
  /** How long in-flight requests may drain before the pools are closed out from under them. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0),
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
