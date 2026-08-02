import type { z } from 'zod';

import type { Session } from '../auth/session';
import { config } from '../config';
import { asWisprError, ConsoleError } from '../errors';

/**
 * The console's server-side client for the gateway.
 *
 * Everything the console reads or writes goes through here, and it runs on the server for one
 * reason: the access token. Handing the browser a token that authorises starting a crawl against
 * the customer's application — under the tenant's own login — is not a trade worth making for a
 * saved network hop, so the browser talks to the console's own routes and the console attaches
 * the credential.
 *
 * Errors arrive as protocol `WisprError`s (`apps/gateway/src/http/server.ts` sends nothing else),
 * so they are parsed with the contract and carried intact. A screen can then render the
 * gateway's own sentence — "the crawl bounds do not allow the application's own origin" — instead
 * of "request failed".
 */

export interface GatewayRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  /** Forwarded on a reconnecting SSE read so the stream resumes exactly where it stopped. */
  readonly lastEventId?: string;
  readonly accept?: string;
  readonly signal?: AbortSignal;
}

/**
 * One gateway call, returning the raw response.
 *
 * Raw, because one caller streams the body straight through to an `EventSource` and buffering it
 * into JSON would defeat the point of a progress stream.
 */
export async function callGateway(session: Session, request: GatewayRequest): Promise<Response> {
  const base = config().GATEWAY_URL.replace(/\/$/, '');

  const headers = new Headers({
    authorization: `Bearer ${session.accessToken}`,
    accept: request.accept ?? 'application/json',
  });
  if (request.body !== undefined) headers.set('content-type', 'application/json');
  if (request.lastEventId !== undefined) headers.set('last-event-id', request.lastEventId);

  try {
    return await fetch(`${base}${request.path}`, {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      // The gateway is an internal service; a cached crawl response would be a crawl that never
      // ran, and a cached progress stream is not a stream.
      cache: 'no-store',
    });
  } catch (cause: unknown) {
    throw new ConsoleError('gateway_unreachable', 'the gateway could not be reached', { cause });
  }
}

/**
 * A gateway call whose response is JSON matching `schema`.
 *
 * A 401 becomes `auth_required` rather than being passed through as a gateway error: the session
 * cookie outlived the token, and the answer is to sign in again — not to show the tester a
 * taxonomy code.
 */
export async function callGatewayJson<T extends z.ZodType>(
  session: Session,
  request: GatewayRequest,
  schema: T,
): Promise<z.infer<T>> {
  const response = await callGateway(session, request);
  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    if (response.status === 401) {
      throw new ConsoleError('auth_required', 'the gateway rejected the session; sign in again');
    }

    const wispr = asWisprError(payload);
    if (wispr !== null) {
      throw new ConsoleError('gateway_rejected', wispr.message, {
        status: response.status,
        wispr,
      });
    }

    throw new ConsoleError(
      'gateway_unreachable',
      `the gateway answered ${String(response.status)} with an unrecognised body`,
      { status: 502 },
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // The gateway and the console are typed from the same contract package, so this means one of
    // them is deployed against a different version of it. Reported as such rather than rendered
    // as an empty screen.
    throw new ConsoleError('gateway_unreachable', 'the gateway returned an unexpected shape', {
      cause: parsed.error,
    });
  }

  return parsed.data;
}
