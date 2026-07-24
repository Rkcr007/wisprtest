/**
 * Gateway error taxonomy.
 *
 * CLAUDE.md § "Conventions" forbids throwing a bare `Error`: every failure carries a stable
 * machine-readable `code` so it can be mapped to an HTTP status by a single error handler and
 * counted in metrics without string matching. Phase 4 extends this union with the auth,
 * tenancy and repository codes; Phase 0 only needs the ones its bootstrap can actually raise.
 */

export type GatewayErrorCode = 'config_invalid' | 'startup_failed';

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
