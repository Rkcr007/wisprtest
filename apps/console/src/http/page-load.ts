import { ConsoleError } from '../errors';

/**
 * A Server Component's reading of a gateway call that failed.
 *
 * Auth failures are not rendered — the page redirects. Everything else is the gateway's (or
 * the console's) own sentence, so a tester sees why the screen is empty rather than an empty
 * screen.
 */
export function pageLoadMessage(error: unknown, fallback: string): string {
  if (error instanceof ConsoleError) return error.message;
  return fallback;
}

export function isAuthRequired(error: unknown): boolean {
  return error instanceof ConsoleError && error.code === 'auth_required';
}
