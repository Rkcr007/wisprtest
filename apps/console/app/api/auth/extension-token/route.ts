import { NextResponse, type NextRequest } from 'next/server';
import { ExtensionToken, ExtensionTokenRequest } from 'protocol';

import { requireSession } from '../../../../src/auth/current';
import { assertExtensionMintCaller } from '../../../../src/auth/mint-caller';
import { config } from '../../../../src/config';
import { callGatewayJson } from '../../../../src/gateway/client';
import { routeErrorResponse } from '../../../../src/http/route-error';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `POST /api/auth/extension-token` — mint a scoped token for the packed extension.
 *
 * The browser never holds the OIDC access token (see `src/gateway/client.ts`). The extension
 * posts here with the console session cookie attached; this process reads the cookie, attaches
 * the bearer, and forwards. The gateway refuses to mint from an already-minted extension token,
 * so this is the only refresh path.
 *
 * Caller check: `assertExtensionMintCaller` — console origin or `chrome-extension://`. A foreign
 * form POST that rides the session cookie is refused before the gateway is touched.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertExtensionMintCaller(request, config());
    const session = await requireSession();

    const body = ExtensionTokenRequest.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        {
          code: 'validation_failed',
          message: 'invalid extension token request',
          issues: body.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.') || 'root',
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    const minted = await callGatewayJson(
      session,
      { method: 'POST', path: '/v1/auth/extension-token', body: body.data },
      ExtensionToken,
    );
    return NextResponse.json(minted);
  } catch (error: unknown) {
    return routeErrorResponse(error, 'the console could not mint an extension token');
  }
}
