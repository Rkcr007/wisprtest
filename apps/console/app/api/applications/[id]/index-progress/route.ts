import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireSession } from '../../../../../src/auth/current';
import { asWisprError, ConsoleError } from '../../../../../src/errors';
import { callGateway } from '../../../../../src/gateway/client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `GET /api/applications/:id/index-progress` — the gateway's SSE stream, proxied.
 *
 * ## Why this proxy exists at all
 *
 * `EventSource` cannot send an `Authorization` header — the API has no way to set one — and the
 * gateway's progress route requires a bearer token. The three ways out are: put the token in the
 * query string (it lands in every access log between here and there), hand the token to the
 * browser and hand-roll SSE over `fetch` (the browser now holds a credential that can start a
 * crawl), or proxy. This proxies. The browser authenticates with its own HTTP-only session
 * cookie, same-origin, and the token stays on the server.
 *
 * ## What it must preserve
 *
 * `Last-Event-ID`. `EventSource` replays it on reconnect and the gateway resumes the Redis stream
 * from exactly that id — dropping it here would silently turn every reconnect into a full replay
 * or, worse, a gap. The body is streamed through untouched, so the gateway's event ids, `retry`
 * interval and keep-alive comments arrive as sent.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  try {
    const applicationId = z.uuid().safeParse(id);
    if (!applicationId.success) {
      throw new ConsoleError('gateway_rejected', 'the application id is not a UUID', {
        status: 400,
      });
    }

    const session = await requireSession();

    const jobId = request.nextUrl.searchParams.get('jobId');
    const query = jobId === null || jobId === '' ? '' : `?jobId=${encodeURIComponent(jobId)}`;
    const lastEventId = request.headers.get('last-event-id');

    const upstream = await callGateway(session, {
      method: 'GET',
      path: `/v1/applications/${applicationId.data}/index-progress${query}`,
      accept: 'text/event-stream',
      ...(lastEventId === null ? {} : { lastEventId }),
      // Closing the tab aborts this request, which aborts the upstream one, which is what lets
      // the gateway drop its blocking Redis read instead of holding a connection for 15 seconds.
      signal: request.signal,
    });

    if (!upstream.ok || upstream.body === null) {
      const payload: unknown = await upstream.json().catch(() => null);
      const wispr = asWisprError(payload);
      // A non-200 stops `EventSource` reconnecting, which is right: an unknown application or a
      // job that does not exist will not start existing on a retry.
      return NextResponse.json(
        {
          code: wispr?.code ?? 'internal',
          message: wispr?.message ?? 'the progress stream could not be opened',
        },
        { status: upstream.status === 200 ? 502 : upstream.status },
      );
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'private, no-store, no-transform',
        // Same reason the gateway sets it: an intermediary that buffers a stream is an
        // intermediary that has turned it into a slow download.
        'x-accel-buffering': 'no',
      },
    });
  } catch (error: unknown) {
    if (error instanceof ConsoleError) {
      return NextResponse.json(
        { code: error.code, message: error.message },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { code: 'internal', message: 'the progress stream could not be opened' },
      { status: 500 },
    );
  }
}
