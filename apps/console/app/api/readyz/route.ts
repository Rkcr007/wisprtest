import { NextResponse } from 'next/server';

import { config } from '../../../src/config';
import { probeGatewayReady } from '../../../src/http/readyz';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `GET /api/readyz` — should traffic be routed here?
 *
 * Asks the gateway's `/readyz` (then `/healthz` if that path is missing). The request carries
 * no session cookie and no bearer token: a readiness probe that forwarded credentials would
 * print them in the orchestrator's probe logs.
 *
 * The response names only the gateway's readiness, never `GATEWAY_URL`, never a header, never
 * a token. A misconfigured `GATEWAY_URL` that contained userinfo is stripped before the
 * fetch (`src/http/readyz.ts`).
 */
export async function GET(): Promise<NextResponse> {
  try {
    const gateway = await probeGatewayReady(config().GATEWAY_URL);
    const ready = gateway.status === 'ready';
    return NextResponse.json(
      { status: ready ? 'ready' : 'not_ready', gateway },
      { status: ready ? 200 : 503 },
    );
  } catch {
    // ConfigError or an unexpected throw. Naming the missing variable is useful in a log;
    // putting it on an unauthenticated probe is how an env dump becomes public.
    return NextResponse.json(
      { status: 'not_ready', gateway: { status: 'unreachable', httpStatus: null } },
      { status: 503 },
    );
  }
}
