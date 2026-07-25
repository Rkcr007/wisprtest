import { normalizeWhitespace } from './redact.js';
import { computeRole } from './role.js';

/**
 * Accessible name computation — the subset of accname that identity actually needs.
 *
 * The highest-weight signal in the table (0.25), because it is the thing the tester says out
 * loud. "Approve" is how a control is referred to; its class list is not.
 *
 * ## What this implements
 *
 * Steps are tried in the order the ARIA accname specification gives them:
 *
 * 1. `aria-labelledby` — dereferenced by id, in the order listed, each target recursed into
 *    with `aria-labelledby` itself disabled so a cycle cannot recur.
 * 2. `aria-label`.
 * 3. Native host-language labelling: `<label for>`, an ancestor `<label>`, `<fieldset>`'s
 *    `<legend>`, `<table>`'s `<caption>`, `<figure>`'s `<figcaption>`, `<img alt>`,
 *    `<input type=submit|reset|button>`'s `value`, and `<optgroup label>`.
 * 4. `placeholder`, for controls with nothing better.
 * 5. Subtree text content, for roles that take their name from content.
 * 6. `title`, as the documented last resort.
 *
 * ## What it does not
 *
 * Deliberately absent, with the reason each is affordable here:
 *
 * - **CSS `::before` / `::after` content.** Step 2F of the algorithm concatenates generated
 *   content. Reading it needs `getComputedStyle` per node, which is a layout-adjacent call the
 *   indexer would pay tens of thousands of times. Icon-font pseudo-content is also exactly the
 *   kind of name that changes with a restyle, so including it would *reduce* stability.
 * - **`aria-describedby`.** That is a description, not a name; the spec never folds it in.
 * - **Recursive traversal into embedded documents** (`<iframe>`, `<slot>` assigned nodes).
 *   Shadow-DOM slotting is Phase 6 territory and needs the host's tree, which this function
 *   does not have.
 * - **`aria-valuetext` and range-widget name-from-value.** Value is content; memory stores
 *   structure.
 * - **Language-specific text direction and full whitespace flattening rules.** Runs of
 *   whitespace are collapsed, which is the part that matters for comparison.
 *
 * ## PII
 *
 * This module returns the *raw* name. Nothing else in the package uses it raw: every caller
 * passes the result through the context's redactor before it is hashed, stored or returned.
 * The separation is deliberate — redaction is a policy applied at the boundary, not something
 * baked into name computation, so a tenant can substitute a stricter one.
 */

/** Roles whose name may be taken from their subtree text, per the ARIA name-from-content rule. */
const NAME_FROM_CONTENT_ROLES = new Set([
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'gridcell',
  'heading',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'row',
  'rowheader',
  'summary',
  'switch',
  'tab',
  'tooltip',
  'treeitem',
]);

/** Controls whose `value` attribute names them. */
const VALUE_NAMED_INPUT_TYPES = new Set(['submit', 'reset', 'button']);

/** Elements skipped when gathering subtree text: they contribute no visible label. */
const TEXT_EXCLUDED_TAGS = new Set(['script', 'style', 'template', 'noscript']);

interface NameContext {
  /** Guards against an `aria-labelledby` cycle and against unbounded recursion. */
  readonly visited: Set<Element>;
  /** False inside a labelledby dereference, per step 2B of the algorithm. */
  readonly followLabelledBy: boolean;
  /**
   * True when the element's own subtree text may name it regardless of its role.
   *
   * Normally only the roles in {@link NAME_FROM_CONTENT_ROLES} name from content — a `<span>`
   * does not name itself by its text. But an element *referenced* by `aria-labelledby`, or
   * traversed as part of a `<label>`, contributes its text whatever its role is. That is what
   * makes `<span id="lbl">Approve</span>` work as a label at all, and it is the difference
   * between "does this element have a name" and "what does this element contribute to one".
   */
  readonly nameFromContent: boolean;
}

/**
 * The element's accessible name, raw and un-redacted.
 *
 * Returns an empty string when the element has no name — which is a real answer, not a failure:
 * plenty of elements are unnamed, and the scoring treats an unnamed pair as a match on that
 * signal rather than penalising both.
 */
export function computeAccessibleName(element: Element): string {
  return nameOf(element, { visited: new Set(), followLabelledBy: true, nameFromContent: false });
}

function nameOf(element: Element, context: NameContext): string {
  if (context.visited.has(element)) return '';
  context.visited.add(element);

  if (context.followLabelledBy) {
    const labelled = fromLabelledBy(element, context);
    if (labelled !== '') return labelled;
  }

  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel !== null && normalizeWhitespace(ariaLabel) !== '') {
    return normalizeWhitespace(ariaLabel);
  }

  // `null` means "no opinion"; an empty string means the host language decided the element has
  // no name, which is a decision and must not fall through to `title`.
  const native = fromHostLanguage(element, context);
  if (native !== null) return native;

  const placeholder = element.getAttribute('placeholder');
  if (placeholder !== null && normalizeWhitespace(placeholder) !== '') {
    return normalizeWhitespace(placeholder);
  }

  if (context.nameFromContent || NAME_FROM_CONTENT_ROLES.has(computeRole(element))) {
    const text = subtreeText(element, context);
    if (text !== '') return text;
  }

  const title = element.getAttribute('title');
  if (title !== null && normalizeWhitespace(title) !== '') return normalizeWhitespace(title);

  return '';
}

function fromLabelledBy(element: Element, context: NameContext): string {
  const idList = element.getAttribute('aria-labelledby');
  if (idList === null) return '';

  const root = element.ownerDocument;
  const parts: string[] = [];
  for (const id of idList.trim().split(/\s+/)) {
    if (id === '') continue;
    const target = root.getElementById(id);
    if (target === null) continue;
    // Step 2B: within a labelledby dereference, the target's own `aria-labelledby` is not
    // followed. Without this a pair of elements pointing at each other recurses forever.
    // `nameFromContent` is forced on: a referenced element contributes its text whatever its
    // role, which is what makes a plain `<span>` usable as a label.
    const part = nameOf(target, {
      visited: context.visited,
      followLabelledBy: false,
      nameFromContent: true,
    });
    if (part !== '') parts.push(part);
  }
  return normalizeWhitespace(parts.join(' '));
}

function fromHostLanguage(element: Element, context: NameContext): string | null {
  const tag = element.tagName.toLowerCase();

  if (tag === 'img' || tag === 'area') {
    const alt = element.getAttribute('alt');
    // An explicit `alt=""` marks the image decorative. That is a *decision*, so it wins over
    // falling through to `title`, and the empty name it produces is the correct answer.
    if (alt !== null) return normalizeWhitespace(alt);
  }

  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (VALUE_NAMED_INPUT_TYPES.has(type)) {
      const value = element.getAttribute('value');
      if (value !== null && normalizeWhitespace(value) !== '') return normalizeWhitespace(value);
      // An unnamed submit button is announced as "Submit" by every browser. Matching that keeps
      // the fingerprint aligned with what a tester hears and says.
      if (type === 'submit') return 'Submit';
      if (type === 'reset') return 'Reset';
    }
  }

  if (tag === 'optgroup') {
    const label = element.getAttribute('label');
    if (label !== null && normalizeWhitespace(label) !== '') return normalizeWhitespace(label);
  }

  if (isLabelable(tag)) {
    const labelled = fromLabelElement(element, context);
    if (labelled !== '') return labelled;
  }

  const child = firstChildNamedBy(element, tag);
  if (child !== null) {
    const text = subtreeText(child, context);
    if (text !== '') return text;
  }

  return null;
}

/** `<fieldset>` is named by its `<legend>`, `<table>` by its `<caption>`, and so on. */
function firstChildNamedBy(element: Element, tag: string): Element | null {
  const childTag =
    tag === 'fieldset'
      ? 'legend'
      : tag === 'table'
        ? 'caption'
        : tag === 'figure'
          ? 'figcaption'
          : tag === 'details'
            ? 'summary'
            : null;
  if (childTag === null) return null;

  for (const candidate of element.children) {
    if (candidate.tagName.toLowerCase() === childTag) return candidate;
  }
  return null;
}

const LABELABLE_TAGS = new Set([
  'button',
  'input',
  'meter',
  'output',
  'progress',
  'select',
  'textarea',
]);

function isLabelable(tag: string): boolean {
  return LABELABLE_TAGS.has(tag);
}

function fromLabelElement(element: Element, context: NameContext): string {
  const parts: string[] = [];

  const id = element.getAttribute('id');
  if (id !== null && id !== '') {
    // `querySelectorAll` rather than `labels`, which happy-dom and older engines implement
    // inconsistently, and which does not exist on every labelable element type.
    for (const label of element.ownerDocument.querySelectorAll('label[for]')) {
      if (label.getAttribute('for') === id) {
        const text = subtreeText(label, context, element);
        if (text !== '') parts.push(text);
      }
    }
  }

  if (parts.length === 0) {
    const ancestor = element.closest('label');
    if (ancestor !== null) {
      // The control sits inside its own label, so its subtree must be excluded from the name —
      // otherwise a text input's value or a select's options leak into the label.
      const text = subtreeText(ancestor, context, element);
      if (text !== '') parts.push(text);
    }
  }

  return normalizeWhitespace(parts.join(' '));
}

/**
 * Flattened text of a subtree, with `exclude` and its descendants omitted.
 *
 * Recurses into elements rather than reading `textContent` so that a nested `aria-label` or
 * `<img alt>` contributes its name instead of nothing, which is what step 2F requires.
 */
function subtreeText(element: Element, context: NameContext, exclude?: Element): string {
  const parts: string[] = [];

  for (const node of element.childNodes) {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      parts.push(node.nodeValue ?? '');
      continue;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) continue;

    const child = node as Element;
    if (child === exclude) continue;
    if (TEXT_EXCLUDED_TAGS.has(child.tagName.toLowerCase())) continue;
    if (child.getAttribute('aria-hidden') === 'true') continue;

    // A labelled descendant contributes its name, not its raw text: an icon button inside a
    // label is announced by its `aria-label`.
    const ariaLabel = child.getAttribute('aria-label');
    if (ariaLabel !== null && normalizeWhitespace(ariaLabel) !== '') {
      parts.push(normalizeWhitespace(ariaLabel));
      continue;
    }
    if (child.tagName.toLowerCase() === 'img') {
      parts.push(child.getAttribute('alt') ?? '');
      continue;
    }

    parts.push(subtreeText(child, context, exclude));
  }

  return normalizeWhitespace(parts.join(' '));
}
