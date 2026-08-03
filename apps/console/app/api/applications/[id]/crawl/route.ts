import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { requireSession } from '../../../../../src/auth/current';
import { StartCrawlRequest, StartCrawlResponse } from '../../../../../src/crawl/request';
import { ConsoleError } from '../../../../../src/errors';
import { callGatewayJson } from '../../../../../src/gateway/client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `POST /api/applications/:id/crawl` — the browser's route to the gateway's crawl endpoint.
 *
 * A thin forwarder by design. It attaches the session's bearer token, which is the one thing the
 * browser must not hold, and it validates the body against the same contract schemas the gateway
 * validates against — so a malformed bound is refused here, on the tester's own screen, with the
 * field named, rather than after a round trip.
 *
 * It does not *fill in* anything. Every bound the gateway requires is a bound the tester chose:
 * CLAUDE.md rule #5 and the crawl route's own reasoning both rest on the bounds being a decision
 * somebody made, and a console that quietly supplied a default page cap would make that untrue
 * while looking identical.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;

  try {
    const applicationId = z.uuid().safeParse(id);
    if (!applicationId.success) {
      throw new ConsoleError('gateway_rejected', 'the application id is not a UUID', {
        status: 400,
      });
    }

    const session = await requireSession();

    const body = StartCrawlRequest.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        {
          code: 'validation_failed',
          message: 'the crawl bounds are incomplete',
          issues: body.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.') || 'root',
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    const started = await callGatewayJson(
      session,
      { method: 'POST', path: `/v1/applications/${applicationId.data}/crawl`, body: body.data },
      StartCrawlResponse,
    );

    return NextResponse.json(started, { status: 202 });
  } catch (error: unknown) {
    return errorResponse(error);
  }
}

/**
 * A console error as JSON the Connect screen can render.
 *
 * `issues` is carried through from a gateway `validation_failed` so the form can attach the
 * gateway's own complaint to the field it names — the origin allowlist check in the crawl route
 * is the one that matters most, and it is worth showing on `bounds.allowedOrigins` rather than as
 * a banner.
 */
function errorResponse(error: unknown): NextResponse {
  if (error instanceof ConsoleError) {
    const wispr = error.wispr;
    return NextResponse.json(
      {
        code: wispr?.code ?? error.code,
        message: error.message,
        issues: wispr !== null && wispr.code === 'validation_failed' ? wispr.issues : [],
      },
      { status: error.status },
    );
  }

  return NextResponse.json(
    { code: 'internal', message: 'the console could not start the crawl', issues: [] },
    { status: 500 },
  );
}
