import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { uiCss } from 'ui';

import { currentSession } from '../src/auth/current';
import { Providers } from '../src/components/providers';
import { consoleCss } from '../src/styles';

export const metadata: Metadata = {
  title: 'WisprTest',
  description: 'Voice-native execution layer for manual QA of enterprise web applications.',
};

/**
 * The console shell.
 *
 * The design system arrives as one `<style>` holding `packages/ui`'s tokens and primitives
 * followed by the console's own rules — the same text the extension HUD adopts into its shadow
 * root, so a mint chip means "this executed" on both surfaces or it means nothing on either.
 * Inlined rather than linked because it is small, it is render-blocking either way, and a
 * separate request would flash an unstyled console on every navigation.
 *
 * The header carries no navigation to screens that do not exist. Phase 18 specifies eight; two
 * are built, and a link to a route that 404s is worse than no link.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await currentSession();

  return (
    <html lang="en">
      <head>
        <style>{`${uiCss}\n${consoleCss}`}</style>
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="masthead">
          <h1>WisprTest</h1>
          <span className="spacer" />
          {session === null ? null : (
            <form action="/auth/logout" method="post">
              <button type="submit">Sign out</button>
            </form>
          )}
        </header>
        <main id="main" className="shell">
          <Providers>{children}</Providers>
        </main>
      </body>
    </html>
  );
}
