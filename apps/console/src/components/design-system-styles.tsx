'use client';

import { uiCss } from 'ui';

import { consoleCss } from '../styles';

/**
 * The design system as one inlined stylesheet: `packages/ui`'s tokens and primitives, then the
 * console's own rules.
 *
 * Inlined rather than linked because it is small, it is render-blocking either way, and a
 * separate request would flash an unstyled console on every navigation.
 *
 * ## Why this is a Client Component when it renders no interactivity
 *
 * `uiCss` is a plain string, and the layout that needs it is a Server Component. But `ui`'s entry
 * point is a barrel that also re-exports `useDraggable` and the HUD primitives, and those call
 * `useState` — so importing anything at all from `ui` inside a Server Component puts a hook in
 * that module's graph, which Next refuses before tree-shaking can remove it.
 *
 * The `'use client'` boundary here is what keeps the barrel out of the server graph. It is a
 * workaround for a packaging detail rather than a design decision: the fix belongs in
 * `packages/ui`, whose client-side modules should carry their own `'use client'` directives (or
 * be reachable through a subpath export that omits them). That package is another track's to
 * change, so this stays on the console's side of the line until it is.
 *
 * Client Components are still server-rendered, so the stylesheet is present in the initial HTML
 * and nothing flashes unstyled while React hydrates.
 */
export function DesignSystemStyles() {
  return <style>{`${uiCss}\n${consoleCss}`}</style>;
}
