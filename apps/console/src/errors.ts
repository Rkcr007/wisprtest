import { WisprError } from 'protocol';

/**
 * The console's error taxonomy.
 *
 * CLAUDE.md § "Conventions": "every service defines a typed error taxonomy; never throw bare
 * `Error`". The console is a client of the gateway rather than an API of its own, so its
 * taxonomy is deliberately small — it names the four ways a console request can fail before or
 * around a gateway call, and carries the gateway's own {@link WisprError} verbatim when the
 * failure came from there.
 *
 * Nothing here ever carries a token, a client secret or a code verifier. `detail` is written for
 * the log line and for an operator reading the screen; the values that would compromise a
 * session are not part of the story it tells.
 */
export type ConsoleErrorCode =
  /** No session, or one that has expired. The caller signs in again. */
  | 'auth_required'
  /** The authorization-code flow itself failed: bad state, provider error, unusable token. */
  | 'auth_failed'
  /** The gateway answered with a typed error. `wispr` holds it. */
  | 'gateway_rejected'
  /** The gateway could not be reached, or answered with something that is not a `WisprError`. */
  | 'gateway_unreachable';

export class ConsoleError extends Error {
  readonly code: ConsoleErrorCode;
  /** HTTP status to answer a console route handler with. */
  readonly status: number;
  /** The gateway's own typed error, when this wraps one. */
  readonly wispr: WisprError | null;

  constructor(
    code: ConsoleErrorCode,
    message: string,
    options: { status?: number; wispr?: WisprError; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ConsoleError';
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    this.wispr = options.wispr ?? null;
  }
}

function defaultStatus(code: ConsoleErrorCode): number {
  switch (code) {
    case 'auth_required':
      return 401;
    case 'auth_failed':
      return 400;
    case 'gateway_rejected':
      return 502;
    case 'gateway_unreachable':
      return 502;
  }
}

/**
 * The gateway's error, if this response body is one.
 *
 * Parsed with the contract rather than read structurally: a 500 from a load balancer is an HTML
 * page, and treating its bytes as a message is how a stack trace ends up rendered to a tester.
 */
export function asWisprError(body: unknown): WisprError | null {
  const parsed = WisprError.safeParse(body);
  return parsed.success ? parsed.data : null;
}
