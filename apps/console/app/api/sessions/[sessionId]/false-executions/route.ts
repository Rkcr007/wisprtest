import { NextResponse, type NextRequest } from 'next/server';
import { FalseExecutionReport, FalseExecutionReportRequest } from 'protocol';
import { z } from 'zod';

import { requireSession } from '../../../../../src/auth/current';
import { callGatewayJson } from '../../../../../src/gateway/client';
import { requireUuid } from '../../../../../src/http/params';
import { routeErrorResponse } from '../../../../../src/http/route-error';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `/api/sessions/:sessionId/false-executions` — read and file false-execution reports.
 *
 * The browser posts here and this process attaches the session bearer, as every other console
 * mutation does. Filing is what finally increments `wispr_false_execution_total`: the counter
 * has existed since Phase 12 and, until the route behind this one, nothing produced it.
 *
 * The gateway answers `GET` with a bare array, so the response is validated as an array of the
 * registered `FalseExecutionReport` contract. Composing the array here rather than adding a
 * named list shape to `packages/protocol` is deliberate — the element is the contract, and a
 * wrapper would be a shape invented by one caller.
 */

const ReportList = z.array(FalseExecutionReport);

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse> {
  const { sessionId: rawId } = await context.params;

  try {
    const sessionId = requireUuid(rawId, 'session id');
    const session = await requireSession();
    const reports = await callGatewayJson(
      session,
      { method: 'GET', path: `/v1/sessions/${sessionId}/false-executions` },
      ReportList,
    );
    return NextResponse.json(reports);
  } catch (error: unknown) {
    return routeErrorResponse(error, 'the console could not load the reports for this session');
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse> {
  const { sessionId: rawId } = await context.params;

  try {
    const sessionId = requireUuid(rawId, 'session id');
    const session = await requireSession();

    const body = FalseExecutionReportRequest.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        { code: 'validation_failed', message: 'the report is incomplete' },
        { status: 400 },
      );
    }

    const report = await callGatewayJson(
      session,
      {
        method: 'POST',
        path: `/v1/sessions/${sessionId}/false-executions`,
        body: body.data,
      },
      FalseExecutionReport,
    );
    return NextResponse.json(report);
  } catch (error: unknown) {
    return routeErrorResponse(error, 'the console could not record that report');
  }
}
