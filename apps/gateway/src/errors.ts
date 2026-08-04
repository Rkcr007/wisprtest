import { WisprError as WisprErrorSchema, type WisprError, type WisprErrorCode } from 'protocol';

/**
 * Gateway error taxonomy, and its single mapping to HTTP.
 *
 * CLAUDE.md § "Conventions" forbids throwing a bare `Error`: every failure carries a stable
 * machine-readable `code` so it can be mapped to a status by one handler and counted in metrics
 * without string matching.
 *
 * There are two layers here, deliberately:
 *
 * - **`WisprErrorCode`**, from `packages/protocol` — every failure that crosses a process
 *   boundary. These are what a client sees, and the contract owns their shape.
 * - **`GatewayInternalCode`** — failures that never leave this process: a missing environment
 *   variable, a repository reached without a tenant in context. They are mapped to a protocol
 *   code before serialisation, so no internal vocabulary leaks into a response.
 */

/** Failures internal to the gateway. Never serialised as-is; see {@link toWisprError}. */
export type GatewayInternalCode =
  'config_invalid' | 'startup_failed' | 'tenant_context_missing' | 'dependency_unavailable';

export type GatewayErrorCode = GatewayInternalCode | WisprErrorCode;

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: GatewayErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/**
 * Raised when the process environment does not satisfy the config schema. Carries every
 * offending variable, not just the first, so a misconfigured deployment is fixed in one pass.
 */
export class ConfigError extends GatewayError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super('config_invalid', `invalid gateway configuration: ${issues.join('; ')}`, { issues });
    this.issues = issues;
  }
}

/**
 * Raised when something tries to reach the database without a tenant in context.
 *
 * A programming error, not a user error: it means a code path bypassed `withTenant`. Reported
 * as 500 rather than 403 — the caller did nothing wrong, and calling it a permission failure
 * would send whoever investigates in exactly the wrong direction.
 */
export class TenantContextMissingError extends GatewayError {
  constructor(operation: string) {
    super(
      'tenant_context_missing',
      `attempted to reach the database without a tenant in context: ${operation}`,
      { operation },
    );
  }
}

/** Raised when a dependency a request needed was unreachable. */
export class DependencyUnavailableError extends GatewayError {
  constructor(dependency: string, options?: ErrorOptions) {
    super('dependency_unavailable', `${dependency} is unavailable`, { dependency }, options);
  }
}

/** Raised when a bearer token is absent, malformed, or fails verification. */
export class UnauthorizedError extends GatewayError {
  constructor(reason: string, options?: ErrorOptions) {
    // `reason` is for the log line, not the response body. Telling an unauthenticated caller
    // precisely why their token failed is a gift to whoever is probing the endpoint.
    super('unauthorized', 'authentication required', { reason }, options);
  }
}

/** Raised when an authenticated principal lacks the permission a route requires. */
export class ForbiddenError extends GatewayError {
  constructor(permission: string, requiredRole: string) {
    super('forbidden', `this action requires the ${requiredRole} role`, {
      permission,
      requiredRole,
    });
  }
}

/** Raised when a tenant exceeds its request budget. */
export class RateLimitedError extends GatewayError {
  constructor(retryAfterSeconds: number) {
    super('rate_limited', 'too many requests', { retryAfterSeconds });
  }
}

/**
 * How each code is reported over HTTP.
 *
 * Exhaustive over `GatewayErrorCode` by construction: `satisfies` turns a missing entry into a
 * compile error, so a code added to the protocol without a decision about its status cannot
 * ship.
 */
export const HTTP_STATUS_BY_CODE = {
  // Internal — mapped through `toWisprError` before they reach a client.
  config_invalid: 500,
  startup_failed: 500,
  tenant_context_missing: 500,
  dependency_unavailable: 503,

  // Resolution.
  resolution_ambiguous: 409,
  resolution_not_found: 404,
  resolution_timeout: 504,

  // Memory.
  memory_version_mismatch: 409,
  memory_snapshot_unavailable: 503,

  // Actions.
  action_confirmation_required: 428,
  action_target_stale: 409,
  action_dispatch_failed: 502,

  // Sessions. A closed session is a conflict with the resource's state, not a malformed request:
  // the same batch would have been accepted a moment earlier.
  session_closed: 409,

  // Composition. An unsatisfiable constraint set is a well-formed request the system cannot
  // fulfil — 422 rather than 400, which would suggest the payload itself was malformed.
  constraint_unsatisfiable: 422,
  schema_confidence_too_low: 422,
  reference_target_missing: 422,
  uniqueness_exhausted: 409,

  // Materialization.
  materializer_unavailable: 501,
  materialization_failed: 502,
  seeding_forbidden: 403,

  // Governance.
  drift_approval_required: 409,

  // Platform.
  unauthorized: 401,
  forbidden: 403,
  rate_limited: 429,
  validation_failed: 400,
  internal: 500,
} as const satisfies Record<GatewayErrorCode, number>;

export function httpStatusFor(code: GatewayErrorCode): number {
  return HTTP_STATUS_BY_CODE[code];
}

/** Internal codes, mapped to the protocol code a client is allowed to see. */
const INTERNAL_TO_PROTOCOL = {
  config_invalid: 'internal',
  startup_failed: 'internal',
  tenant_context_missing: 'internal',
  dependency_unavailable: 'internal',
} as const satisfies Record<GatewayInternalCode, WisprErrorCode>;

function isInternalCode(code: GatewayErrorCode): code is GatewayInternalCode {
  return code in INTERNAL_TO_PROTOCOL;
}

const OPAQUE_INTERNAL = 'Something failed unexpectedly. Quote this id to support.';

/**
 * A thrown value that is already a valid protocol error.
 *
 * Plugins raise these: `@fastify/rate-limit`'s `errorResponseBuilder` returns the body it wants
 * sent, and it arrives here as the thrown value rather than as a `GatewayError`. Rather than
 * special-casing that one plugin, anything that satisfies the contract's own schema is passed
 * through — validated by the schema itself, so a payload that merely looks close is not.
 */
export function asWisprError(value: unknown): WisprError | null {
  const parsed = WisprErrorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Convert any thrown value into the `WisprError` that goes on the wire.
 *
 * Every branch produces a payload that satisfies the contract's own schema, including the
 * branch for a thrown value that is not an `Error` at all — a handler that throws while
 * handling a failure is how a 500 becomes a hung connection.
 *
 * `traceId` is required rather than optional. The `internal` variant carries it, and it is the
 * only thing a tester should ever be asked to quote back to support.
 */
export function toWisprError(error: unknown, traceId: string): WisprError {
  if (error instanceof GatewayError) return fromGatewayError(error, traceId);

  const passthrough = asWisprError(error);
  if (passthrough !== null) return passthrough;

  return { code: 'internal', message: OPAQUE_INTERNAL, retryable: true, traceId };
}

function fromGatewayError(error: GatewayError, traceId: string): WisprError {
  // Internal detail stays in the log line, which carries the same trace id. The response says
  // only that something failed, and how to find out what.
  if (isInternalCode(error.code)) {
    return { code: 'internal', message: OPAQUE_INTERNAL, retryable: true, traceId };
  }

  switch (error.code) {
    case 'unauthorized':
      return { code: 'unauthorized', message: error.message, retryable: false };
    case 'forbidden':
      return {
        code: 'forbidden',
        message: error.message,
        retryable: false,
        requiredRole: readRole(error.details.requiredRole),
      };
    case 'rate_limited':
      return {
        code: 'rate_limited',
        message: error.message,
        retryable: true,
        retryAfterSeconds: readNonNegativeInt(error.details.retryAfterSeconds),
      };
    case 'validation_failed':
      return {
        code: 'validation_failed',
        message: error.message,
        retryable: false,
        issues: readIssues(error.details.issues, error.message),
      };
    case 'resolution_timeout':
      // The first construction site for this code: Phase 11's T2 escalation is the first thing
      // the gateway runs that has a latency budget it can blow. The extension reads `retryable`
      // and the tier and falls back to disambiguation rather than waiting on a slow model.
      return {
        code: 'resolution_timeout',
        message: error.message,
        retryable: true,
        tier: readTier(error.details.tier),
        budgetMs: readNonNegativeNumber(error.details.budgetMs),
        elapsedMs: readNonNegativeNumber(error.details.elapsedMs),
      };
    case 'session_closed':
      // The tester's session ended while a flush was in flight — a late buffer, a tab closed
      // mid-batch. The extension cannot fix it by retrying, so the steps are reported lost against
      // a named session rather than silently appended to a finished timeline.
      return {
        code: 'session_closed',
        message: error.message,
        retryable: false,
        sessionId: readUuid(error.details.sessionId) ?? ZERO_UUID,
        endedAt: readIsoDateTime(error.details.endedAt),
      };
    case 'resolution_not_found':
      // T2 ran but could not return a usable pick — an unparseable answer, or a candidate id it
      // invented. The honest report is that the phrase did not resolve; the extension then shows
      // the ranked T1 candidates it already holds.
      return {
        code: 'resolution_not_found',
        message: error.message,
        retryable: false,
        targetPhrase: readText(error.details.targetPhrase),
        tier: readTier(error.details.tier),
      };
    case 'memory_snapshot_unavailable': {
      const applicationId = readUuid(error.details.applicationId);
      // The contract's variant carries the application id; without a valid one the honest thing
      // is an internal error rather than a body that fails its own schema.
      if (applicationId === null) {
        return { code: 'internal', message: OPAQUE_INTERNAL, retryable: true, traceId };
      }
      return {
        code: 'memory_snapshot_unavailable',
        message: error.message,
        retryable: true,
        applicationId,
      };
    }
    case 'seeding_forbidden':
      // Environment policy refused the write. Not retryable and not a permission problem the
      // caller can fix by trying harder: an application has to be auditably opted in, by a human,
      // in the console. The environment travels with it so the HUD can say *which* one.
      return {
        code: 'seeding_forbidden',
        message: error.message,
        retryable: false,
        applicationId: readUuid(error.details.applicationId) ?? ZERO_UUID,
        environment: readText(error.details.environment) || 'unknown',
      };
    case 'schema_confidence_too_low':
      // The engine declining to guess. § 7: "refuse with the specific missing field; offer to
      // index the create form." The named fields are the whole value of the refusal — without
      // them a tester has been told no and given nothing to do about it.
      return {
        code: 'schema_confidence_too_low',
        message: error.message,
        retryable: false,
        entity: readText(error.details.entity) || 'unknown',
        confidence: readConfidence(error.details.confidence),
        threshold: readConfidence(error.details.threshold),
        missingFields: readStrings(error.details.missingFields),
      };
    case 'materializer_unavailable':
      // Nothing in this application knows how to create the record. 501 rather than 500: the
      // request was understood and is simply not implementable against this app's learned
      // knowledge, and re-indexing — not retrying — is what changes the answer.
      return {
        code: 'materializer_unavailable',
        message: error.message,
        retryable: false,
        entity: readText(error.details.entity) || 'unknown',
        triedAdapters: readAdapters(error.details.triedAdapters),
      };
    case 'materialization_failed':
      // Every rung of the chain failed. Retryable, because the usual causes are transient — a
      // worker that was not listening, a form that was slow — and the per-attempt reasons in the
      // result are what say whether retrying is worth anything.
      return {
        code: 'materialization_failed',
        message: error.message,
        retryable: true,
        planId: readUuid(error.details.planId) ?? ZERO_UUID,
        adapter: readAdapter(error.details.adapter),
      };
    default:
      // A protocol code this phase can name but has no richer construction for yet. Reported as
      // `internal` rather than guessed at: a half-populated variant would fail the contract's
      // own schema, which is a worse outcome than an honest 500.
      return { code: 'internal', message: OPAQUE_INTERNAL, retryable: true, traceId };
  }
}

const ROLES = ['owner', 'lead', 'tester', 'viewer'] as const;
type Role = (typeof ROLES)[number];

function readRole(value: unknown): Role {
  return ROLES.includes(value as Role) ? (value as Role) : 'owner';
}

function readNonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function readNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

const TIERS = ['T0', 'T1', 'T2'] as const;
type TierValue = (typeof TIERS)[number];

/** A tier off an error's details, or `T2` — the only tier that constructs these errors so far. */
function readTier(value: unknown): TierValue {
  return TIERS.includes(value as TierValue) ? (value as TierValue) : 'T2';
}

/** A redacted display string off an error's details. Empty string when absent — never raw text. */
function readText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ADAPTERS = ['api', 'ui', 'fixture'] as const;
type Adapter = (typeof ADAPTERS)[number];

/** An adapter kind off an error's details, or `ui` — the one adapter always present. */
function readAdapter(value: unknown): Adapter {
  return ADAPTERS.includes(value as Adapter) ? (value as Adapter) : 'ui';
}

function readAdapters(value: unknown): Adapter[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Adapter => ADAPTERS.includes(entry as Adapter))
    : [];
}

/** Plain strings off an error's details — field names, never values. */
function readStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** A score clamped into [0, 1], because the contract will not accept anything else. */
function readConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function readUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

/**
 * The all-zero UUID, for an error whose contract requires an id the thrower did not supply.
 *
 * Only reachable through a bug: every construction site passes the real id. It exists so the
 * response still satisfies the contract rather than failing validation on the way out — an error
 * that cannot be serialised is an error the client never sees at all.
 */
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** An ISO timestamp off an error's details, or the epoch when one was not supplied. */
function readIsoDateTime(value: unknown): string {
  if (typeof value !== 'string') return new Date(0).toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? new Date(0).toISOString() : new Date(parsed).toISOString();
}

interface WireValidationIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Coerce the `details.issues` a route attached into the contract's `ValidationIssue[]`.
 *
 * The variant requires at least one issue with a non-empty path and message. A route that
 * supplied well-formed ones has them passed through; anything else collapses to a single issue
 * carrying the error's own message, so the body always satisfies its schema.
 */
function readIssues(value: unknown, fallbackMessage: string): WireValidationIssue[] {
  if (Array.isArray(value)) {
    const issues = value.filter(
      (issue): issue is WireValidationIssue =>
        typeof issue === 'object' &&
        issue !== null &&
        typeof (issue as { path?: unknown }).path === 'string' &&
        (issue as { path: string }).path.length > 0 &&
        typeof (issue as { message?: unknown }).message === 'string' &&
        (issue as { message: string }).message.length > 0,
    );
    if (issues.length > 0)
      return issues.map((issue) => ({ path: issue.path, message: issue.message }));
  }
  return [{ path: 'root', message: fallbackMessage }];
}
