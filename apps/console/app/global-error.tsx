'use client';

import type { ReactElement } from 'react';

/**
 * Last-resort console error boundary.
 *
 * Next prerenders this route outside the request context, so it cannot use the ordinary root
 * layout (which requires the per-request CSP nonce). The boundary owns its document and uses no
 * inline script or style. At runtime Next applies the proxy's nonce to its framework scripts.
 */
export default function GlobalError({
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}): ReactElement {
  return (
    <html lang="en">
      <body>
        <main>
          <h1>WisprTest could not render this screen</h1>
          <p>The failure was recorded. Retry the screen before restarting your testing session.</p>
          <button type="button" onClick={reset}>
            Retry
          </button>
        </main>
      </body>
    </html>
  );
}
