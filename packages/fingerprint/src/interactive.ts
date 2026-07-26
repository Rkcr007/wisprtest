import type { Rect } from './config.js';
import { computeRole } from './role.js';

/**
 * What counts as an element a tester can act on.
 *
 * Shared verbatim by the Playwright indexer and the extension's runtime state engine, for the
 * same reason the fingerprint itself is (CLAUDE.md rule #4): the indexer records this set into
 * memory, and the runtime scopes resolution to this set. If the two ever disagreed, the scoped
 * candidate set would contain elements memory has never heard of and omit ones it has — and the
 * failure would be silent, because both halves would look correct on their own.
 */

/**
 * Roles that make an element something a tester can act on.
 *
 * Role-based rather than tag-based because that is the identity the rest of the system uses: a
 * `<div role="button">` is a button here for the same reason it is one to a screen reader and to
 * the resolver.
 */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

/**
 * Elements that are interactive regardless of their computed role.
 *
 * `<summary>` toggles a disclosure, and an element with a `tabindex` or `contenteditable` has
 * been made operable by its author even when its role stays `generic`.
 */
export function isInteractiveByAuthorIntent(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === 'summary' || tag === 'select' || tag === 'textarea') return true;
  if (element.hasAttribute('contenteditable')) return true;

  const tabIndex = element.getAttribute('tabindex');
  return tabIndex !== null && tabIndex !== '-1';
}

/** Whether this one element is something a tester could act on. */
export function isInteractiveCandidate(element: Element): boolean {
  return INTERACTIVE_ROLES.has(computeRole(element)) || isInteractiveByAuthorIntent(element);
}

/**
 * Every interactive **descendant** of `root`, in document order.
 *
 * Descendants only — `root` itself is not tested, matching `querySelectorAll` semantics. Callers
 * walking an arbitrary subtree (the runtime state engine, processing an added node) test the root
 * separately with {@link isInteractiveCandidate}; the indexer passes `document.body`, which is
 * never a candidate.
 *
 * Document order is what makes the indexer's marker numbering reproducible: the crawler re-stamps
 * this same walk after returning from a navigation, and the nth element has to still be the nth.
 */
export function interactiveCandidates(root: Element): Element[] {
  const candidates: Element[] = [];
  for (const element of root.querySelectorAll('*')) {
    if (isInteractiveCandidate(element)) candidates.push(element);
  }
  return candidates;
}

/** Whether an element is disabled, natively or through ARIA. */
export function isDisabled(element: Element): boolean {
  if (element.getAttribute('aria-disabled') === 'true') return true;
  return element.closest(':disabled, [disabled], fieldset[disabled]') !== null;
}

/**
 * Whether the author has marked this element, or an ancestor, as not present.
 *
 * `hidden` and `aria-hidden` are semantic: they say the element is out of the accessibility tree
 * and therefore out of reach, regardless of what the layout happens to be doing. Kept separate
 * from the style check below because the two have different costs and different consumers — the
 * runtime state engine gets CSS visibility from its IntersectionObserver for free and needs only
 * this half.
 */
export function isSemanticallyHidden(element: Element): boolean {
  return element.closest('[hidden], [aria-hidden="true"]') !== null;
}

/**
 * Whether an element, or an ancestor, is `inert`.
 *
 * `inert` removes a subtree from focus and from pointer interaction entirely — it is how the
 * platform expresses "this is behind a modal". Distinct from `aria-hidden`, which affects the
 * accessibility tree without disabling interaction.
 */
export function isInert(element: Element): boolean {
  return element.closest('[inert]') !== null;
}

/** Whether CSS is currently hiding an element. Requires a live layout engine. */
export function isStyleHidden(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (view === null) return false;

  const style = view.getComputedStyle(element);
  return style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0';
}

/** Whether an element is rendered and non-trivially sized. */
export function isVisible(element: Element, rect: Rect): boolean {
  if (rect.width <= 1 && rect.height <= 1) return false;
  if (isSemanticallyHidden(element)) return false;
  return !isStyleHidden(element);
}
