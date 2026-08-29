import { redirect } from 'next/navigation';
import { z } from 'zod';

import { currentSession } from '../auth/current';
import type { Session } from '../auth/session';
import { ConsoleError } from '../errors';
import { isAuthRequired } from './page-load';

/**
 * A signed-in session and a UUID application id, or a redirect / renderable error.
 */
export async function requireApplicationPage(
  rawId: string,
  pathname: string,
): Promise<
  | { readonly ok: true; readonly applicationId: string; readonly session: Session }
  | { readonly ok: false; readonly error: string }
> {
  const parsed = z.uuid().safeParse(rawId);
  if (!parsed.success) {
    return { ok: false, error: 'the application id is not a UUID' };
  }

  const session = await currentSession();
  if (session === null) {
    redirect(`/auth/login?next=${encodeURIComponent(pathname)}`);
  }
  return { ok: true, applicationId: parsed.data, session };
}

export function redirectIfAuth(error: unknown, pathname: string): void {
  if (isAuthRequired(error) || (error instanceof ConsoleError && error.code === 'auth_required')) {
    redirect(`/auth/login?next=${encodeURIComponent(pathname)}`);
  }
}
