'use client';

import { usePathname } from 'next/navigation';

import {
  APPLICATION_SCREENS,
  applicationHref,
  isAdminActive,
  isScreenActive,
  parseApplicationId,
} from '../nav/screens';

/**
 * Application screens in the masthead, plus the tenant-wide Admin destination.
 *
 * Client-only because it reads the pathname. Admin is not nested under an application: RBAC
 * and the audit log are tenant facts, not per-app ones.
 */
export function AppNav() {
  const pathname = usePathname();
  const applicationId = parseApplicationId(pathname);

  return (
    <nav aria-label="Application">
      {applicationId === null
        ? null
        : APPLICATION_SCREENS.map((screen) => {
            const href = applicationHref(applicationId, screen.key);
            const current = isScreenActive(pathname, applicationId, screen.key);
            return (
              <a key={screen.key} href={href} aria-current={current ? 'page' : undefined}>
                {screen.label}
              </a>
            );
          })}
      <a href="/admin" aria-current={isAdminActive(pathname) ? 'page' : undefined}>
        Admin
      </a>
    </nav>
  );
}
