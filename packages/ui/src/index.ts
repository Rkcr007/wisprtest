/**
 * `ui` — the shared design system.
 *
 * Semantic tokens, `useDraggable`, and the HUD primitives. Consumed by the extension HUD (which
 * adopts {@link uiCss} into a shadow root) and by the console (docs/BUILD-PLAN.md Phase 18), so
 * the two surfaces cannot drift visually or, more importantly, semantically: a mint chip means
 * "this executed" in both places, or it means nothing anywhere.
 *
 * ```ts
 * import { uiCss, Chip, Cell, useDraggable } from 'ui';
 *
 * const sheet = new CSSStyleSheet();
 * sheet.replaceSync(uiCss);
 * shadowRoot.adoptedStyleSheets = [sheet];
 * ```
 */

export {
  PALETTE_TOKENS,
  STRUCTURAL_TOKENS,
  TOKENS,
  tokensCss,
  tokenValue,
  tokenVar,
  type DesignToken,
  type TokenKind,
} from './tokens.js';

export { primitivesCss } from './primitives.css.js';

export {
  Cell,
  Chip,
  GhostCursor,
  NoData,
  Reticle,
  Toast,
  VadBars,
  type CellProps,
  type ChipProps,
  type GhostCursorProps,
  type ReticleProps,
  type ReticleRect,
  type ToastProps,
  type Tone,
  type VadBarsProps,
} from './primitives.js';

export {
  clamp,
  magnetize,
  toEdge,
  transformFor,
  useDraggable,
  type Draggable,
  type DraggableOptions,
  type Edge,
  type HandleProps,
  type Position,
} from './useDraggable.js';

import { primitivesCss } from './primitives.css.js';
import { tokensCss } from './tokens.js';

/**
 * Tokens plus primitives, in the order they must be applied.
 *
 * One export because a consumer that adopts the primitives without the tokens gets a stylesheet
 * of `var(--wispr-…)` references resolving to nothing — every colour transparent, every gap zero.
 */
export const uiCss = `${tokensCss}\n${primitivesCss}`;
