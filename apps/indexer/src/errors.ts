/**
 * Indexer error taxonomy.
 *
 * Per CLAUDE.md § "Conventions", every failure carries a stable machine-readable code rather
 * than being a bare `Error`. Phase 5 adds the crawl codes (SSRF rejection, auth profile
 * failure, route budget exhausted); Phase 0 only needs what its bootstrap can raise.
 */

export type IndexerErrorCode = 'config_invalid' | 'startup_failed';

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
