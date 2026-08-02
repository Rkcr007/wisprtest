import { NextResponse, type NextRequest } from 'next/server';

import { discover, exchangeCode } from '../../../src/auth/oidc';
import {
  cookieOptions,
  FLOW_COOKIE,
  openFlow,
  sealSession,
  SESSION_COOKIE,
} from '../../../src/auth/session';
import { config } from '../../../src/config';
import { ConsoleError } from '../../../src/errors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `GET /auth/callback` — finish the authorization-code flow.
 *
 * Order matters here. The `state` is compared *before* the code is exchanged, so a code
 * fabricated by a third party is never presented to the token endpoint at all; and the flow
 * cookie is cleared on every path, success or failure, so one attempt's verifier can never be
 * replayed by a second.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const cfg = config();
  const params = request.nextUrl.searchParams;

  const flowCookie = request.cookies.get(FLOW_COOKIE);
  const flow = flowCookie === undefined ? null : await openFlow(cfg, flowCookie.value);

  const failure = (message: string): NextResponse => {
    const response = NextResponse.redirect(
      new URL(`/?authError=${encodeURIComponent(message)}`, request.nextUrl.origin),
    );
    response.cookies.delete(FLOW_COOKIE);
    return response;
  };

  const providerError = params.get('error');
  if (providerError !== null) {
    return failure(`the identity provider refused sign-in: ${providerError}`);
  }

  if (flow === null) {
    return failure('the sign-in attempt expired; try again');
  }

  const state = params.get('state');
  if (state === null || state !== flow.state) {
    // A callback whose state does not match the one this browser was given is not this browser's
    // sign-in. Refused without touching the token endpoint.
    return failure('the sign-in response did not match the request');
  }

  const code = params.get('code');
  if (code === null || code === '') {
    return failure('the identity provider returned no authorization code');
  }

  try {
    const metadata = await discover(cfg);
    const tokens = await exchangeCode(metadata, cfg, { code, verifier: flow.verifier });

    const lifetimeSeconds = Math.floor((tokens.expiresAt - Date.now()) / 1000);
    if (lifetimeSeconds <= 0) {
      return failure('the identity provider issued a token that is already expired');
    }

    const response = NextResponse.redirect(new URL(flow.returnTo, request.nextUrl.origin));
    response.cookies.set(
      SESSION_COOKIE,
      await sealSession(cfg, tokens),
      cookieOptions(cfg, lifetimeSeconds),
    );
    response.cookies.delete(FLOW_COOKIE);
    return response;
  } catch (error: unknown) {
    return failure(error instanceof ConsoleError ? error.message : 'sign-in failed');
  }
}
