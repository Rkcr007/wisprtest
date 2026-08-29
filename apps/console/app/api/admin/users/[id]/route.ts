import { NextResponse, type NextRequest } from 'next/server';

import { AdminUser, PatchUserRole } from '../../../../../src/admin/schema';
import { requireSession } from '../../../../../src/auth/current';
import { callGatewayJson } from '../../../../../src/gateway/client';
import { requireUuid } from '../../../../../src/http/params';
import { routeErrorResponse } from '../../../../../src/http/route-error';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `PATCH /api/admin/users/:id` — change a teammate's role.
 *
 * Forwards the session cookie's bearer. The gateway still requires `admin:manage`.
 */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;

  try {
    const userId = requireUuid(id, 'user id');
    const session = await requireSession();
    const body = PatchUserRole.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        { code: 'validation_failed', message: 'the role change is incomplete' },
        { status: 400 },
      );
    }
    const updated = await callGatewayJson(
      session,
      { method: 'PATCH', path: `/v1/admin/users/${userId}`, body: body.data },
      AdminUser,
    );
    return NextResponse.json(updated);
  } catch (error: unknown) {
    return routeErrorResponse(error, 'the console could not change that role');
  }
}
