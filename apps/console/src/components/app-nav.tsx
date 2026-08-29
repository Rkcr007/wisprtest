'use client';

import { usePathname } from 'next/navigation';

import {
  APPLICATION_SCREENS,
  applicationHref,
  isScreenActive,
  parseApplicationId,
} from '../nav/screens';

/**
 * Application screens in the masthead, when the URL names an application.
 *
 * Client-only because it reads the pathname. The destinations exist: Wave 1 fills Drift and
 * Session detail; the others are honest shells that say what they will load once the gateway
 * exposes the read. A link to a heading is better than a link that 404s, and better than
 * hiding the IA until every screen is built.
 */
export function AppNav() {
  const pathname = usePathname();
  const applicationId = parseApplicationId(pathname);
  if (applicationId === null) return null;

  return (
    <nav aria-label="Application">
      {APPLICATION_SCREENS.map((screen) => {
        const href = applicationHref(applicationId, screen.key);
        const current = isScreenActive(pathname, applicationId, screen.key);
        return (
          <a key={screen.key} href={href} aria-current={current ? 'page' : undefined}>
            {screen.label}
          </a>
        );
      })}
    </nav>
  );
}
