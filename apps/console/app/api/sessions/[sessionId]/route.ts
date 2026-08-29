import { NextResponse } from 'next/server';
import { SessionTimeline } from 'protocol';

import { requireSession } from '../../../../src/auth/current';
import { callGatewayJson } from '../../../../src/gateway/client';
import { requireUuid } from '../../../../src/http/params';
import { routeErrorResponse } from '../../../../src/http/route-error';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `GET /api/sessions/:sessionId` — one session's timeline and signed evidence.
 *
 * Forwards the session cookie's bearer token. Evidence bytes never transit this process:
 * the gateway returns short-lived signed URLs, and the console renders those as links.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse> {
  const { sessionId: rawId } = await context.params;

  try {
    const sessionId = requireUuid(rawId, 'session id');
    const session = await requireSession();
    const timeline = await callGatewayJson(
      session,
      { method: 'GET', path: `/v1/sessions/${sessionId}` },
      SessionTimeline,
    );
    return NextResponse.json(timeline);
  } catch (error: unknown) {
    return routeErrorResponse(error, 'the console could not load the session');
  }
}
