import { tokenValue, uiCss } from 'ui';

import { hudCss } from './hud.css.js';

/**
 * Mounting the HUD without disturbing the page it is mounted on.
 *
 * The extension attaches to a customer's application, and the first rule of doing that is that
 * the application must behave exactly as it would without us. A QA tool that changes what it is
 * observing produces bug reports about itself.
 *
 * Four decisions, each closing off a specific way overlays break their host:
 *
 * 1. **A shadow root**, so the host's CSS cannot reach our tree and ours cannot reach theirs. A
 *    `<style>` tag in the host document would restyle their page from the moment it is injected;
 *    a class name collision would restyle ours.
 * 2. **Adopted stylesheets**, not injected `<style>` elements. The sheet is constructed and
 *    adopted into the shadow root, so the host document's `styleSheets` collection is untouched —
 *    which matters for applications that enumerate it, and for our own test that asserts it.
 * 3. **Mounted on `documentElement`, not `body`.** Applications style their body's children
 *    (`body > *`), count them, and lay them out. Appending outside the body keeps
 *    `document.body.children` exactly as the application left it.
 * 4. **`pointer-events: none` on the container.** The container spans the viewport so the panel
 *    can be dragged anywhere in it, and every event that is not on the panel passes through to
 *    the application underneath.
 *
 * The host element's own geometry is set with `!important`, because a host page with
 * `* { position: static !important }` — which exists — would otherwise drop the HUD into the
 * document flow and push its layout around.
 */

/** The custom element name of the host. Never registered: it exists to be unlikely to collide. */
export const HOST_TAG = 'wispr-test-hud';

export interface MountedHud {
  readonly host: HTMLElement;
  readonly shadowRoot: ShadowRoot;
  /** Where React renders. Inside the shadow root, never in the host document. */
  readonly container: HTMLElement;
  unmount(): void;
}

/**
 * Create the host element and its shadow root, and return the container React renders into.
 *
 * Idempotent: mounting twice on one page — a second injection after a soft navigation, say —
 * reuses the existing host rather than stacking a second HUD on the first.
 */
export function mountHudHost(document: Document): MountedHud {
  const existing = document.documentElement.querySelector(HOST_TAG);
  if (existing !== null) existing.remove();

  const host = document.createElement(HOST_TAG);

  // `all: initial` first, so nothing the page declares for `*` reaches the host, then only the
  // properties the container genuinely needs. Both stages are `!important`: a host page can and
  // does use `!important` on universal selectors.
  host.style.cssText = [
    'all: initial !important',
    'position: fixed !important',
    'top: 0 !important',
    'left: 0 !important',
    'width: 0 !important',
    'height: 0 !important',
    'margin: 0 !important',
    'padding: 0 !important',
    'border: 0 !important',
    'overflow: visible !important',
    // Above the application's own fixed chrome. This has to be on the *host*: `all: initial`
    // resets the host's own `z-index` to `auto`, and the shadow tree then stacks wherever the
    // host does — underneath any header the application gave a large z-index, which is most of
    // them. The value is read from the design token rather than written twice.
    `z-index: ${tokenValue('z-hud')} !important`,
    // The container inside the shadow root does the viewport-spanning; the host stays zero-sized
    // so it can never contribute to the host document's scroll size.
    'pointer-events: none !important',
  ].join('; ');

  const shadowRoot = host.attachShadow({
    /**
     * Open, deliberately.
     *
     * The requirement is CSS and DOM isolation, which `open` provides in full — the host page's
     * selectors do not cross a shadow boundary in either direction regardless of mode. `closed`
     * adds only the inability of page script to reach `element.shadowRoot`, and the page here is
     * the customer's own application, not an adversary. What `closed` would reliably obstruct is
     * our own end-to-end tests and a tester's devtools.
     */
    mode: 'open',
  });

  adoptStyles(shadowRoot, document);

  const container = document.createElement('div');
  shadowRoot.append(container);

  // `documentElement`, not `body`: see the module comment. This is the single node the extension
  // adds to the page.
  document.documentElement.append(host);

  return {
    host,
    shadowRoot,
    container,
    unmount: () => {
      host.remove();
    },
  };
}

/**
 * Put the design system and the HUD's styles into the shadow root.
 *
 * Constructed stylesheets are the whole point: `adoptedStyleSheets` attaches rules to the shadow
 * root without creating a node in the host document. The `<style>` fallback also lives *inside*
 * the shadow root — on an engine without constructable stylesheets we lose the sharing, never the
 * isolation.
 */
function adoptStyles(shadowRoot: ShadowRoot, document: Document): void {
  const css = `${uiCss}\n${hudCss}`;

  if (typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadowRoot.adoptedStyleSheets = [sheet];
      return;
    } catch {
      // Fall through to the element form below.
    }
  }

  const style = document.createElement('style');
  style.textContent = css;
  shadowRoot.append(style);
}
