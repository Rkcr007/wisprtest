import { NextResponse } from 'next/server';

import { ConsoleError } from '../errors';

/**
 * A console error as JSON a screen or the extension can render.
 *
 * `issues` is carried through from a gateway `validation_failed` so a form can attach the
 * gateway's own complaint to the field it names.
 */
export function routeErrorResponse(error: unknown, fallbackMessage: string): NextResponse {
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
    { code: 'internal', message: fallbackMessage, issues: [] },
    { status: 500 },
  );
}
