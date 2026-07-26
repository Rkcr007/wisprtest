import { pathOf } from 'fingerprint';

import { installRouteBridge, ROUTE_EVENT, type RuntimeWindow } from './route-bridge.js';

/**
 * Where the current route comes from.
 *
 * ## Four signals, because no one of them is complete
 *
 * 1. **`popstate`** — the back button, and `history.go`. A real DOM event; reaches the content
 *    script's isolated world.
 * 2. **`hashchange`** — hash routers, which are still how a great deal of enterprise software
 *    routes. Also a real event.
 * 3. **The route bridge's event** — `pushState` and `replaceState` called by the application.
 *    These are method calls in the page's own world, invisible from here, which is the entire
 *    reason `route-bridge.ts` exists.
 * 4. **`poke()`** — a re-read the state engine performs at the end of every mutation burst.
 *
 * The fourth is a backstop, not the mechanism. A route change that reaches none of the first
 * three is one where a page rewrote history through a channel we cannot see; it will always have
 * re-rendered something, so the mutation stream catches it a burst late rather than never. It
 * costs one string comparison per burst, which is the right price for removing a class of
 * silent failure.
 *
 * This is not polling: nothing here runs on a timer, and a page that neither navigates nor
 * mutates schedules no work at all.
 *
 * ## The isolated-world patch, which is not redundant
 *
 * `installRouteBridge` is also applied to the content script's own realm. The bridge in the main
 * world does not see calls made from here — the asymmetry runs both ways — and from Phase 10 the
 * action executor navigates on the tester's behalf. Patching both realms means a navigation is
 * observed whoever made it.
 */

export interface RouteSourceOptions {
  /** Called when the path changes. Not called when a signal fires but the path is the same. */
  readonly onChange: (path: string) => void;
}

export interface RouteSource {
  /** The current path, normalised: no origin, no query, no fragment, no trailing slash. */
  readonly path: string;
  /** Re-read the location and report a change if there is one. Cheap; safe to call often. */
  poke(): void;
  dispose(): void;
}

export function createRouteSource(target: RuntimeWindow, options: RouteSourceOptions): RouteSource {
  installRouteBridge(target);

  let path = pathOf(target.location.href);

  const poke = (): void => {
    const next = pathOf(target.location.href);
    if (next === path) return;
    path = next;
    options.onChange(next);
  };

  // One handler for all three events. Every signal means the same thing — "the location may have
  // moved" — and the location itself is the authority on whether it did. Nothing is read from the
  // events, which matters for the bridge's: it crosses from the page's world, where a hostile or
  // merely buggy application could dispatch one carrying anything it liked.
  target.addEventListener('popstate', poke);
  target.addEventListener('hashchange', poke);
  target.document.addEventListener(ROUTE_EVENT, poke);

  return {
    get path(): string {
      return path;
    },

    poke,

    dispose(): void {
      target.removeEventListener('popstate', poke);
      target.removeEventListener('hashchange', poke);
      target.document.removeEventListener(ROUTE_EVENT, poke);
    },
  };
}
