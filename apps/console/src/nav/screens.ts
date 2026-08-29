import { z } from 'zod';

/**
 * The five application screens, in the order the masthead lists them.
 *
 * Paths are relative to `/applications/:id`. Overview is the application root. Admin is
 * tenant-wide and lives at `/admin`, not under an application. Indexing is a live job view,
 * not one of these five — a tester reaches it from Connect after starting a crawl.
 */
export const APPLICATION_SCREENS = [
  { key: 'overview', label: 'Overview', path: '' },
  { key: 'memory', label: 'Memory', path: '/memory' },
  { key: 'data', label: 'Data', path: '/data' },
  { key: 'sessions', label: 'Sessions', path: '/sessions' },
  { key: 'drift', label: 'Drift', path: '/drift' },
] as const;

export type ApplicationScreenKey = (typeof APPLICATION_SCREENS)[number]['key'];

const APPLICATION_PATH = /^\/applications\/([^/]+)(?:\/(.*))?$/;

/**
 * The application id in a console pathname, or null when the URL is not an application route.
 *
 * A non-UUID segment is treated as "no application" rather than interpolated into an href —
 * the nav must not become a vector for an open-redirect-shaped link.
 */
export function parseApplicationId(pathname: string): string | null {
  const match = APPLICATION_PATH.exec(pathname);
  if (match === null) return null;
  const parsed = z.uuid().safeParse(match[1]);
  return parsed.success ? parsed.data : null;
}

/** Absolute href for one application screen. */
export function applicationHref(applicationId: string, key: ApplicationScreenKey): string {
  const screen = APPLICATION_SCREENS.find((entry) => entry.key === key);
  return `/applications/${applicationId}${screen?.path ?? ''}`;
}

/**
 * Whether `pathname` is this screen, including nested routes that belong to it.
 *
 * Overview is exact: `/applications/:id/indexing` is the crawl view, not the overview.
 * Sessions includes `/sessions/:sessionId` so the detail view keeps the parent current.
 */
/** Whether the tenant-wide Admin screen is current. */
export function isAdminActive(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

export function isScreenActive(
  pathname: string,
  applicationId: string,
  key: ApplicationScreenKey,
): boolean {
  const href = applicationHref(applicationId, key);
  if (key === 'overview') {
    return pathname === href || pathname === `${href}/`;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
