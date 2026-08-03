import { cookies } from 'next/headers';

import { config } from '../config';
import { ConsoleError } from '../errors';
import { openSession, SESSION_COOKIE, type Session } from './session';

/**
 * The signed-in session of the request being served, read from the encrypted cookie.
 *
 * Server-only: `next/headers` throws outside a request, which is the behaviour we want — a token
 * read at module scope would be one request's credential reused for everybody else's.
 */
export async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  const cookie = jar.get(SESSION_COOKIE);
  if (cookie === undefined) return null;
  return openSession(config(), cookie.value);
}

/** The session, or a typed 401 the route handlers translate into a sign-in redirect. */
export async function requireSession(): Promise<Session> {
  const session = await currentSession();
  if (session === null) {
    throw new ConsoleError('auth_required', 'sign in to continue');
  }
  return session;
}
