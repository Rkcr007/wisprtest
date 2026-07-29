import { Session, SessionStepIngestResult, type SessionStep } from 'protocol';

/**
 * The session client, in the service worker.
 *
 * Opens a session on attach, flushes buffered steps, and closes on detach — all with the scoped
 * token, which never crosses into the page. Same shape as the memory, escalation and alias
 * clients, and the same split of responsibilities: this is transport, and the buffer above it
 * decides what to retry.
 *
 * ## Why the failures are typed rather than thrown blind
 *
 * `SessionWriteFailed` carries `retryable`, and the buffer reads exactly that. A 5xx or a dead
 * connection is worth another tick; a closed session or a rejected batch will fail identically
 * forever, and retrying it would wedge the queue behind steps that can never land.
 */

export const SESSIONS_PATH = '/v1/sessions';

export class SessionWriteFailed extends Error {
  readonly retryable: boolean;
  /** The protocol error code, when the gateway sent one. Null for a transport failure. */
  readonly code: string | null;

  constructor(detail: string, retryable: boolean, code: string | null = null) {
    super(`session write failed: ${detail}`);
    this.name = 'SessionWriteFailed';
    this.retryable = retryable;
    this.code = code;
  }
}

export interface SessionClientOptions {
  /** Origin of the control plane. Must match the manifest's `host_permissions`. */
  readonly gatewayOrigin: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface SessionClient {
  open(input: {
    applicationId: string;
    memoryVersionId: string;
    bearerToken: string;
  }): Promise<Session>;
  sendSteps(sessionId: string, steps: readonly SessionStep[], bearerToken: string): Promise<void>;
  close(sessionId: string, bearerToken: string): Promise<void>;
}

export function createSessionClient(options: SessionClientOptions): SessionClient {
  const { gatewayOrigin, fetch: fetchImpl = globalThis.fetch.bind(globalThis) } = options;
  const url = (path: string): string => new URL(path, gatewayOrigin).href;

  async function request(
    path: string,
    method: 'POST' | 'PATCH',
    body: unknown,
    bearerToken: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(url(path), {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error: unknown) {
      throw new SessionWriteFailed(error instanceof Error ? error.message : 'network error', true);
    }

    if (!response.ok) {
      const code = await codeOf(response);
      // A closed session and a rejected batch are permanent; a 5xx, a 429 or an expired token are
      // worth another attempt. 401/403 is retryable because the worker refreshes tokens on a
      // timer — the next flush may well carry a valid one.
      const retryable =
        response.status >= 500 || response.status === 429 || response.status === 401;
      throw new SessionWriteFailed(`HTTP ${String(response.status)}`, retryable, code);
    }

    try {
      return await response.json();
    } catch (error: unknown) {
      throw new SessionWriteFailed(error instanceof Error ? error.message : 'invalid JSON', false);
    }
  }

  return {
    async open(input): Promise<Session> {
      const payload = await request(
        SESSIONS_PATH,
        'POST',
        { applicationId: input.applicationId, memoryVersionId: input.memoryVersionId },
        input.bearerToken,
      );
      const parsed = Session.safeParse(payload);
      // Validated before it is held: the id is what every subsequent step is written against, and
      // a malformed one would fail on every flush for the rest of the session.
      if (!parsed.success) throw new SessionWriteFailed('malformed session', false);
      return parsed.data;
    },

    async sendSteps(sessionId, steps, bearerToken): Promise<void> {
      const payload = await request(
        `${SESSIONS_PATH}/${sessionId}/steps`,
        'POST',
        { steps },
        bearerToken,
      );
      const parsed = SessionStepIngestResult.safeParse(payload);
      if (!parsed.success) throw new SessionWriteFailed('malformed ingest result', false);
    },

    async close(sessionId, bearerToken): Promise<void> {
      await request(`${SESSIONS_PATH}/${sessionId}`, 'PATCH', { status: 'closed' }, bearerToken);
    },
  };
}

/** Read the protocol error `code` from a failed response, tolerating a missing or invalid body. */
async function codeOf(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'code' in body) {
      const { code } = body;
      return typeof code === 'string' ? code : null;
    }
  } catch {
    // A body-less or non-JSON failure is classified by status alone.
  }
  return null;
}
