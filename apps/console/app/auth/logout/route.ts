import { NextResponse, type NextRequest } from 'next/server';

import { FLOW_COOKIE, SESSION_COOKIE } from '../../../src/auth/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `POST /auth/logout` — drop the session.
 *
 * A POST, not a GET: a sign-out reachable by navigation can be triggered by any page that can
 * make the browser fetch a URL, and being signed out mid-crawl-configuration is a real annoyance.
 * The token itself is not revoked at the provider — that is an RP-initiated logout, which needs
 * the `end_session_endpoint` and an id-token hint the console does not currently keep.
 */
export function POST(request: NextRequest): NextResponse {
  const response = NextResponse.redirect(new URL('/', request.nextUrl.origin), { status: 303 });
  response.cookies.delete(SESSION_COOKIE);
  response.cookies.delete(FLOW_COOKIE);
  return response;
}
