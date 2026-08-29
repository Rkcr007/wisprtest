import { NextResponse, type NextRequest } from 'next/server';

import { registerOrReuse } from '../../../src/applications/register';
import { ApplicationList, CreateApplicationRequest } from '../../../src/applications/schema';
import { requireSession } from '../../../src/auth/current';
import { callGatewayJson } from '../../../src/gateway/client';
import { routeErrorResponse } from '../../../src/http/route-error';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `GET /api/applications` — the applications this tenant has registered.
 *
 * Includes the active memory version, screen/element counts, index time and open drift when
 * those rows exist. Zeros and nulls are the honest answer for an app that has never been indexed.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const listed = await callGatewayJson(
      session,
      { method: 'GET', path: '/v1/applications' },
      ApplicationList,
    );
    return NextResponse.json(listed);
  } catch (error: unknown) {
    return routeErrorResponse(error, 'the console could not list applications');
  }
}

/**
 * `POST /api/applications` — register an application, or reuse the row this tenant already has
 * for that name at that origin.
 *
 * The crawl still needs an id. Until this existed the Connect form asked a lead to paste a UUID.
 * A lead names a URL; this route stores the row (or finds it); crawl uses the id that comes back.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const body = CreateApplicationRequest.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        {
          code: 'validation_failed',
          message: 'the application is incomplete',
          issues: body.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.') || 'root',
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    const { created, application } = await registerOrReuse(session, body.data);
    return NextResponse.json(application, { status: created ? 201 : 200 });
  } catch (error: unknown) {
    return routeErrorResponse(error, 'the console could not register the application');
  }
}
