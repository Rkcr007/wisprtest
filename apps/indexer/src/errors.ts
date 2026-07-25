import type { IndexFailureCode } from 'protocol';

/**
 * Indexer error taxonomy.
 *
 * Per CLAUDE.md § "Conventions", every failure carries a stable machine-readable code rather than
 * being a bare `Error`. The codes that can end a crawl job are exactly `IndexFailureCode` from
 * `packages/protocol`, because that value is written to `memory_versions.failure_reason` and
 * streamed to the console — a taxonomy the operator can read is the point of having one.
 *
 * The remaining codes are process-level: they happen before or outside a job, so they have no
 * memory version to be recorded against.
 */

/** Codes that can end a job, mirrored from the contract, plus the process-level ones. */
export type IndexerErrorCode = IndexFailureCode | 'config_invalid' | 'startup_failed';

export class IndexerError extends Error {
  readonly code: IndexerErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: IndexerErrorCode,
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

export class ConfigError extends IndexerError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super('config_invalid', `invalid indexer configuration: ${issues.join('; ')}`, { issues });
    this.issues = issues;
  }
}

/**
 * A job whose bounds are absent, malformed, or internally inconsistent.
 *
 * docs/BUILD-PLAN.md Phase 5: "These bounds are config, and the crawl must refuse to start
 * without them." This is that refusal, and it happens before a browser is launched.
 */
export class BoundsError extends IndexerError {
  constructor(issues: readonly string[]) {
    super('bounds_invalid', `crawl bounds are unusable: ${issues.join('; ')}`, { issues });
  }
}

/**
 * A navigation target that failed the SSRF policy.
 *
 * `reason` is a fixed phrase, never a resolver error string, so the message is safe to log and
 * to show. The rejected URL is included because an operator debugging an allowlist needs it and
 * a URL the crawler refused to visit contains no page content.
 */
export class SsrfError extends IndexerError {
  constructor(url: string, reason: string) {
    super('ssrf_rejected', `navigation target rejected: ${reason}`, { url, reason });
  }
}

/** The auth profile did not produce an authenticated session. */
export class AuthError extends IndexerError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super('auth_failed', message, details);
  }
}

/**
 * A secret reference could not be resolved.
 *
 * Carries the reference, never the value — and never the value's length, which is a fingerprint
 * of the credential in its own right.
 */
export class SecretError extends IndexerError {
  constructor(provider: string, key: string, reason: string) {
    super('secret_unavailable', `could not resolve ${provider} secret: ${reason}`, {
      provider,
      key,
      reason,
    });
  }
}

/** The browser could not be launched, or died mid-crawl. */
export class BrowserError extends IndexerError {
  constructor(message: string, options?: ErrorOptions) {
    super('browser_failed', message, {}, options);
  }
}

/** A navigation timed out or returned a status the crawler cannot index. */
export class NavigationError extends IndexerError {
  constructor(url: string, reason: string, options?: ErrorOptions) {
    super('navigation_failed', `navigation to ${url} failed: ${reason}`, { url, reason }, options);
  }
}

/** Writing memory failed. The version is left `failed`, never half-`active`. */
export class PersistenceError extends IndexerError {
  constructor(message: string, options?: ErrorOptions) {
    super('persistence_failed', message, {}, options);
  }
}

/** The worker is shutting down and did not finish the job it held. */
export class CancelledError extends IndexerError {
  constructor(reason: string) {
    super('cancelled', `crawl cancelled: ${reason}`, { reason });
  }
}

/** The `IndexFailureCode` to record for an arbitrary thrown value. */
export function failureCodeOf(error: unknown): IndexFailureCode {
  if (
    error instanceof IndexerError &&
    error.code !== 'config_invalid' &&
    error.code !== 'startup_failed'
  ) {
    return error.code;
  }
  // An unexpected throw is not a navigation problem or an auth problem, and guessing which would
  // send an operator down the wrong path. Crawling is what failed; say so.
  return 'browser_failed';
}

/** A one-line, PII-free description of a failure, for `memory_versions.failure_reason`. */
export function failureDetailOf(error: unknown): string {
  if (error instanceof IndexerError) return error.message;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return 'unknown error';
}
