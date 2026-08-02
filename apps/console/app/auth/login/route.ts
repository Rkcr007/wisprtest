import { NextResponse, type NextRequest } from 'next/server';

import { authorizationUrl, createPkce, discover, randomToken } from '../../../src/auth/oidc';
import {
  cookieOptions,
  FLOW_COOKIE,
  FLOW_TTL_SECONDS,
  safeReturnTo,
  sealFlow,
} from '../../../src/auth/session';
import { config } from '../../../src/config';
import { ConsoleError } from '../../../src/errors';

/** Nothing about this response may be cached or prerendered: it mints per-attempt secrets. */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `GET /auth/login` — start the authorization-code flow.
 *
 * The per-attempt secrets (PKCE verifier, CSRF state, nonce) go into an encrypted, HTTP-only
 * cookie rather than into server memory: the console runs as more than one replica in production
 * and the callback is a *fresh* request that can land on any of them. State kept in a process
 * would make sign-in fail intermittently, which is the hardest kind of auth bug to see.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const cfg = config();

  try {
    const metadata = await discover(cfg);
    const pkce = await createPkce();
    const state = randomToken(16);
    const nonce = randomToken(16);
    const returnTo = safeReturnTo(request.nextUrl.searchParams.get('next'));

    const response = NextResponse.redirect(
      authorizationUrl(metadata, cfg, { state, nonce, challenge: pkce.challenge }),
    );
    response.cookies.set(
      FLOW_COOKIE,
      await sealFlow(cfg, { verifier: pkce.verifier, state, nonce, returnTo }),
      cookieOptions(cfg, FLOW_TTL_SECONDS),
    );
    return response;
  } catch (error: unknown) {
    const message = error instanceof ConsoleError ? error.message : 'sign-in could not be started';
    return NextResponse.redirect(
      new URL(`/?authError=${encodeURIComponent(message)}`, request.nextUrl.origin),
    );
  }
}
