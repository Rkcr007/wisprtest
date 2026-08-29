import { NextResponse } from 'next/server';
import { DriftListResponse } from 'protocol';

import { requireSession } from '../../../../../src/auth/current';
import { callGatewayJson } from '../../../../../src/gateway/client';
import { requireUuid } from '../../../../../src/http/params';
import { routeErrorResponse } from '../../../../../src/http/route-error';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `GET /api/applications/:id/drift` — pending reports for one application.
 *
 * Thin forwarder: attaches the session bearer the browser must not hold, and parses the
 * response with the same `DriftListResponse` the gateway sends. The tester's tenant comes
 * from that session, never from the query string.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;

  try {
    const applicationId = requireUuid(id, 'application id');
    const session = await requireSession();
    const listed = await callGatewayJson(
      session,
      { method: 'GET', path: `/v1/drift/${applicationId}` },
      DriftListResponse,
    );
    return NextResponse.json(listed);
  } catch (error: unknown) {
    return routeErrorResponse(error, 'the console could not load drift reports');
  }
}
