import { NextResponse, type NextRequest } from 'next/server';
import { SeedRevertRequest, SeedRevertResponse } from 'protocol';

import { requireSession } from '../../../../src/auth/current';
import { callGatewayJson } from '../../../../src/gateway/client';
import { routeErrorResponse } from '../../../../src/http/route-error';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `POST /api/seed/revert` — undo one ledger entry or a whole session.
 *
 * Class S. The browser posts here; this process attaches the session bearer.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const body = SeedRevertRequest.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        { code: 'validation_failed', message: 'the revert request is incomplete' },
        { status: 400 },
      );
    }
    const result = await callGatewayJson(
      session,
      { method: 'POST', path: '/v1/seed/revert', body: body.data },
      SeedRevertResponse,
    );
    return NextResponse.json(result);
  } catch (error: unknown) {
    return routeErrorResponse(error, 'the console could not revert that record');
  }
}
