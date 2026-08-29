import { NextResponse, type NextRequest } from 'next/server';
import { DriftDecisionRequest, DriftDecisionResponse } from 'protocol';

import { requireSession } from '../../../../../src/auth/current';
import { callGatewayJson } from '../../../../../src/gateway/client';
import { requireUuid } from '../../../../../src/http/params';
import { routeErrorResponse } from '../../../../../src/http/route-error';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `POST /api/drift/:id/approve` — a human's decision on one report.
 *
 * The body is the contract's `DriftDecisionRequest`: `{ decision: 'approve' }` or
 * `{ decision: 'reject', reason }`. This route does not interpret roles or the report
 * lifecycle. The gateway refuses a caller without `drift:approve`, a report that is not
 * yet reconciled, and a report that has already been decided — and those refusals pass
 * through as the gateway wrote them.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;

  try {
    const reportId = requireUuid(id, 'drift report id');
    const session = await requireSession();

    const body = DriftDecisionRequest.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        {
          code: 'validation_failed',
          message: 'the drift decision is incomplete',
          issues: body.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.') || 'root',
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    const decided = await callGatewayJson(
      session,
      { method: 'POST', path: `/v1/drift/${reportId}/approve`, body: body.data },
      DriftDecisionResponse,
    );

    return NextResponse.json(decided);
  } catch (error: unknown) {
    return routeErrorResponse(error, 'the console could not record the drift decision');
  }
}
