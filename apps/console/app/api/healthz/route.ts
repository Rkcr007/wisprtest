import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `GET /api/healthz` — is this process alive?
 *
 * Touches nothing external. A liveness probe that checked the gateway would let a brief
 * control-plane blip convince the orchestrator to kill every console replica at once.
 */
export function GET(): NextResponse {
  return NextResponse.json({ status: 'ok' });
}
