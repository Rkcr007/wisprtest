import type { ConsoleConfig } from '../config';
import { ConsoleError } from '../errors';

/**
 * Who may call the console's extension-token proxy.
 *
 * The session cookie is `SameSite=Lax` and HTTP-only, so a page on another origin cannot read it.
 * A cross-site *form* POST can still send it. This check is what stops that: the mint route
 * accepts the console's own origin (a same-site fetch from Connect) and `chrome-extension://`
 * (the packed service worker). Anything else — including a missing Origin, which a simple form
 * POST from a foreign page still sets — is refused before the gateway is touched.
 */
export function assertExtensionMintCaller(request: Request, cfg: ConsoleConfig): void {
  const origin = request.headers.get('origin');
  const consoleOrigin = new URL(cfg.OIDC_REDIRECT_URI).origin;
  if (origin === consoleOrigin) return;
  if (origin !== null && origin.startsWith('chrome-extension://')) return;

  throw new ConsoleError(
    'auth_required',
    'minting is only allowed from the console or the packed extension',
    { status: 403 },
  );
}
