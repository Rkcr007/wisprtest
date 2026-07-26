/**
 * The route bridge — the one piece of WisprTest that runs in the application's own world.
 *
 * ## Why it exists
 *
 * A content script runs in an isolated world. It shares the DOM with the page but not the
 * JavaScript realm, so `History.prototype.pushState` there is a *different function object* from
 * the one the application calls. Patching it in the content script observes nothing.
 *
 * `popstate` and `hashchange` are DOM events and do reach the isolated world. `pushState` and
 * `replaceState` are method calls and do not — which is unfortunate, because they are how every
 * single-page application routes. This file closes that gap and nothing else.
 *
 * ## What it is allowed to do
 *
 * It shares globals with a customer's production application, which is the most invasive place
 * any of our code runs. The rules it holds itself to:
 *
 * - **No imports beyond this file.** Bundled standalone from `route-bridge.main.ts` (see
 *   `src/build.ts`), so no other part of the extension — not React, not the design system, not a
 *   build-time constant — is reachable from the page.
 * - **No extension API.** `chrome.*` is unavailable in the main world anyway; nothing here
 *   reaches for it. The bridge cannot see a token because it has no way to ask for one.
 * - **It reads no page content and sends no data.** The event it dispatches carries no payload.
 *   The isolated world reads `location` itself, which it can already do. Passing the URL across
 *   would mean trusting a value the page can forge, in exchange for nothing.
 * - **It changes no observable behaviour.** The patched methods forward every argument and
 *   return value, and a throw from the original propagates unchanged — the notification happens
 *   only after a call that succeeded.
 *
 * ## Why a DOM event rather than `postMessage`
 *
 * `window.postMessage` is a channel the application is probably already listening on, and a
 * message it does not recognise can trip its own handlers. A `CustomEvent` on `document` with a
 * namespaced type is inert to code that is not listening for that exact name.
 */

/**
 * The event type the isolated world listens for.
 *
 * Duplicated in `route.ts` rather than imported: importing would pull the extension's module
 * graph into the page's world, which is the one thing this file may not do. It is a constant
 * string, and `route-bridge.test.ts` asserts the two copies agree.
 */
const ROUTE_EVENT = 'wispr:route';

/** Marks the document so a second injection does not stack a second patch on the first. */
const INSTALLED_ATTRIBUTE = 'data-wispr-route-bridge';

type HistoryMethod = 'pushState' | 'replaceState';

const PATCHED: readonly HistoryMethod[] = ['pushState', 'replaceState'];

/**
 * A window the runtime can both observe and construct events in.
 *
 * TypeScript's `Window` interface carries instances, not constructors — those live on
 * `typeof globalThis`, which this package cannot name because it is typechecked with `WebWorker`
 * in `lib` for the service worker's sake. Naming the one constructor actually needed keeps the
 * requirement explicit and lets a test pass a constructed window without widening anything.
 */
export type RuntimeWindow = Window & { readonly CustomEvent: typeof CustomEvent };

export function installRouteBridge(target: RuntimeWindow): void {
  const root = target.document.documentElement;
  if (root.hasAttribute(INSTALLED_ATTRIBUTE)) return;
  root.setAttribute(INSTALLED_ATTRIBUTE, '');

  const announce = (): void => {
    // `bubbles: false`, `composed: false`, no `detail`. The event's only job is to say "look
    // again"; everything about what changed is read from `location` by the listener.
    target.document.dispatchEvent(new target.CustomEvent(ROUTE_EVENT));
  };

  for (const method of PATCHED) {
    // Deliberately unbound. The patch forwards with `.apply(this, args)` so that an application
    // calling `history.pushState.call(someOtherHistory, …)` still reaches the history it named —
    // binding here would silently redirect it. `unbound-method` is guarding against an accidental
    // `this`; this one is the whole mechanism.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = target.history[method];

    // A `function`, not an arrow: it forwards the caller's own `this` through `.apply` below,
    // which an arrow would replace with this module's.
    const patched = function patchedHistoryMethod(
      this: History,
      ...args: Parameters<History[typeof method]>
    ): void {
      // The call first, and unguarded: a `try` here that swallowed a throw would change the
      // application's behaviour, and an argument the platform rejects must go on rejecting it.
      original.apply(this, args);

      // Only after it succeeded. Announcing a route the browser refused would be a lie, and the
      // engine would fingerprint a state that never existed.
      announce();
    };

    // Applications feature-detect on these — a framework that finds `pushState.length === 0`
    // concludes the platform is too old and falls back to hash routing. Keeping the descriptors
    // right is what makes the patch genuinely transparent.
    Object.defineProperty(patched, 'name', { value: method, configurable: true });
    Object.defineProperty(patched, 'length', { value: original.length, configurable: true });
    Object.defineProperty(patched, 'toString', {
      value: () => original.toString(),
      configurable: true,
      writable: true,
    });

    target.history[method] = patched;
  }
}

export { INSTALLED_ATTRIBUTE, ROUTE_EVENT };
