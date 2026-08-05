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

  // ── Indexing ───────────────────────────────────────────────────────────────────────────────
  /**
   * Redis stream `CrawlJob`s are enqueued on, relative to the `wispr:` key namespace.
   *
   * Must be the same value the indexer reads as `INDEXER_JOB_STREAM`. The two services resolve
   * the namespace differently — the gateway through ioredis's `keyPrefix`, the indexer in code —
   * but they must land on the same key, and a mismatch fails silently: the gateway reports a job
   * enqueued and no worker ever sees it. Hence no default here either; the value is stated once
   * in `.env` and both services read it.
   */
  INDEXER_JOB_STREAM: z.string().min(1),

  /**
   * Redis stream `SeedJob`s are enqueued on. Must match the indexer's `INDEXER_SEED_STREAM`.
   *
   * Separate from the crawl stream for the reason stated there: a seed job has a tester's request
   * held open behind it, and queueing one behind a multi-minute crawl would time the request out.
   */
  SEED_JOB_STREAM: z.string().min(1),

  /**
   * Redis stream `DriftReconcileJob`s are enqueued on. Must match `INDEXER_DRIFT_STREAM`.
   *
   * Its own stream for the same reason the seed one has its own: a reconcile opens a browser and
   * takes tens of seconds, and sharing the crawl stream would put it behind a job that runs for
   * minutes. Nothing waits on a reconcile, but a review queue that fills up faster than it drains
   * is still a broken learning loop.
   */
  DRIFT_JOB_STREAM: z.string().min(1),

  // ── Drift ──────────────────────────────────────────────────────────────────────────────────
  /**
   * Wall-clock ceiling handed to a reconcile job.
   *
   * Sized for a navigation, an extraction and a schema observation pass — not for a crawl. The
   * worker enforces it; this is the number written into the job so the two cannot disagree.
   */
  DRIFT_RECONCILE_TIMEOUT_MS: z.coerce.number().int().min(1000),

  // ── Seeding ────────────────────────────────────────────────────────────────────────────────
  /** Base URL of the composer. It is stateless, so this is the only thing needed to reach it. */
  COMPOSER_URL: z.url({ protocol: /^https?$/ }),
  /**
   * Hard ceiling on a composition call.
   *
   * CLAUDE.md § "Performance budgets" puts the preview at 1.2 s p95, and the composer enforces
   * that on its own side too. This is the gateway refusing to hold a tester's request open past
   * the point where the preview would have been useful.
   */
  COMPOSER_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000),
  /**
   * How long a composed plan is held for approval.
   *
   * The gateway keeps the plan and hands back an id, so approval cannot smuggle in an edited
   * record (see `SeedExecuteRequest`). The window is the tester's reading time plus a margin —
   * long enough to consider a preview, short enough that memory has not moved underneath it.
   */
  SEED_PLAN_TTL_SECONDS: z.coerce.number().int().min(30).max(3600),
  /**
   * How long to wait for the UI materializer's result before giving up on it.
   *
   * Generous by the standards of everything else here: driving a real form is 3–15 s per
   * TEST-DATA-ENGINE § 4, and the tester has explicitly approved a write and is watching for it.
   * Must stay below the indexer's `INDEXER_SEED_RESULT_TTL_SECONDS`, so a result outlives the
   * request waiting for it.
   */
  SEED_MATERIALIZE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000),

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
