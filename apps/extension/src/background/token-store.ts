import { ExtensionToken } from 'protocol';

/**
 * Where the scoped token lives while the service worker is not running.
 *
 * Chrome terminates an idle MV3 service worker after about thirty seconds, and every module-level
 * variable goes with it. Without somewhere to put the token, the first command after any pause in
 * a tester's session would pay for a token round trip.
 *
 * `chrome.storage.session` and not `chrome.storage.local`:
 *
 * - **Session storage is memory-backed.** The token never touches disk, and it is gone when the
 *   browser closes. A bearer token scoped to a customer's tenant does not belong in a file that
 *   outlives the session that minted it.
 * - **It can be closed to content scripts.** `setAccessLevel('TRUSTED_CONTEXTS')` — the default,
 *   set explicitly here because it is load-bearing rather than incidental — means a content
 *   script cannot read this area at all. The content script runs in a page the extension does not
 *   control; an XSS in the application under test must not be able to read a credential out of it.
 */

export interface TokenStore {
  read(origin: string): Promise<ExtensionToken | null>;
  write(origin: string, token: ExtensionToken): Promise<void>;
  clear(origin: string): Promise<void>;
}

/** The storage surface used here, narrowed so a test can supply one without a browser. */
export interface SessionStorageArea {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
  setAccessLevel?(options: {
    accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
  }): Promise<void>;
}

/** Keys are namespaced so this area can hold other worker state without collision. */
export function tokenKey(origin: string): string {
  return `wispr:token:${origin}`;
}

export function createTokenStore(area: SessionStorageArea): TokenStore {
  // Stated rather than assumed. If a future Chrome changes the default, this line is what keeps
  // the token out of content scripts, and its absence would be silent.
  void area.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });

  return {
    async read(origin: string): Promise<ExtensionToken | null> {
      const key = tokenKey(origin);
      const stored = await area.get(key);

      const parsed = ExtensionToken.safeParse(stored[key]);
      // A stored value that no longer parses — an upgrade that changed the contract, a partial
      // write — is discarded rather than repaired. Minting a new token costs one request; using a
      // half-understood credential costs more than that.
      return parsed.success ? parsed.data : null;
    },

    async write(origin: string, token: ExtensionToken): Promise<void> {
      await area.set({ [tokenKey(origin)]: token });
    },

    async clear(origin: string): Promise<void> {
      await area.remove(tokenKey(origin));
    },
  };
}
