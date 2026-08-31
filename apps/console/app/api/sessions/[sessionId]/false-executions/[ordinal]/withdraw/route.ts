import { NextResponse, type NextRequest } from 'next/server';
import { FalseExecutionReport, FalseExecutionWithdrawRequest } from 'protocol';
import { z } from 'zod';

import { requireSession } from '../../../../../../../src/auth/current';
import { ConsoleError } from '../../../../../../../src/errors';
import { callGatewayJson } from '../../../../../../../src/gateway/client';
import { requireUuid } from '../../../../../../../src/http/params';
import { routeErrorResponse } from '../../../../../../../src/http/route-error';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `POST /api/sessions/:sessionId/false-executions/:ordinal/withdraw` — retract a report.
 *
 * A withdrawal moves the numerator of the release gate downward, which is why the gateway
 * requires a reason and writes the act to `audit_log`. The reason is checked here too so a
 * tester is told before spending a round trip, not instead of the gateway checking.
 *
 * The ordinal is validated as a non-negative integer before it reaches the upstream path, for
 * the same reason `requireUuid` guards the session id: a malformed segment should be a legible
 * 400 here rather than an upstream 404 that reads as a missing report.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string; ordinal: string }> },
): Promise<NextResponse> {
  const { sessionId: rawId, ordinal: rawOrdinal } = await context.params;

  try {
    const sessionId = requireUuid(rawId, 'session id');

    const ordinal = z.coerce.number().int().min(0).safeParse(rawOrdinal);
    if (!ordinal.success) {
      throw new ConsoleError('gateway_rejected', 'the step ordinal is not a whole number', {
        status: 400,
      });
    }

    const session = await requireSession();

    const body = FalseExecutionWithdrawRequest.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        {
          code: 'validation_failed',
          message: 'a withdrawal names why',
          issues: [{ path: 'reason', message: 'a withdrawal names why' }],
        },
        { status: 400 },
      );
    }

    const report = await callGatewayJson(
      session,
      {
        method: 'POST',
        path: `/v1/sessions/${sessionId}/false-executions/${String(ordinal.data)}/withdraw`,
        body: body.data,
      },
      FalseExecutionReport,
    );
    return NextResponse.json(report);
  } catch (error: unknown) {
    return routeErrorResponse(error, 'the console could not withdraw that report');
  }
}
