/**
 * Computed ARIA role.
 *
 * The highest-weight *structural* signal (0.20) because it survives a restyle: a button that
 * becomes a `<div role="button">`, or a class rename from `.btn` to `.Button_root__x1y`, keeps
 * its role while every CSS-derived selector breaks.
 *
 * ## What this implements
 *
 * An explicit `role` attribute wins, taking the first token as the spec requires. Otherwise the
 * implicit role is derived from the tag name, and from the handful of attributes that change it
 * — `<input type>`, `<a href>`, and the sectioning elements whose role depends on whether they
 * are accessibly named.
 *
 * ## What it does not
 *
 * The full HTML-AAM mapping is considerably larger than this. Not covered: presentational role
 * inheritance, `<td>`/`<th>` roles varying by ancestor table role, the `<li>` role depending on
 * its list parent, roles suppressed by `hidden`/`aria-hidden`, and abstract-role validation of
 * an author-supplied `role`. Those matter for an accessibility audit; for identity they cost
 * more than they add, since an element whose role changes for those reasons has usually changed
 * enough that the other six signals move too.
 */

/** Tag names whose role is fixed regardless of attributes. */
const STATIC_ROLES: Readonly<Record<string, string>> = {
  article: 'article',
  aside: 'complementary',
  button: 'button',
  datalist: 'listbox',
  dd: 'definition',
  details: 'group',
  dialog: 'dialog',
  dt: 'term',
  fieldset: 'group',
  figure: 'figure',
  form: 'form',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  hr: 'separator',
  html: 'document',
  img: 'img',
  li: 'listitem',
  main: 'main',
  menu: 'list',
  meter: 'meter',
  nav: 'navigation',
  ol: 'list',
  optgroup: 'group',
  option: 'option',
  output: 'status',
  p: 'paragraph',
  progress: 'progressbar',
  search: 'search',
  select: 'combobox',
  summary: 'summary',
  table: 'table',
  tbody: 'rowgroup',
  td: 'cell',
  textarea: 'textbox',
  tfoot: 'rowgroup',
  th: 'columnheader',
  thead: 'rowgroup',
  tr: 'row',
  ul: 'list',
};

/** `<input type>` → role. Types absent from this map have no role of their own. */
const INPUT_ROLES: Readonly<Record<string, string>> = {
  button: 'button',
  checkbox: 'checkbox',
  email: 'textbox',
  image: 'button',
  number: 'spinbutton',
  radio: 'radio',
  range: 'slider',
  reset: 'button',
  search: 'searchbox',
  submit: 'button',
  tel: 'textbox',
  text: 'textbox',
  url: 'textbox',
};

/**
 * `<section>` is a `region` only when it carries an accessible name, and nothing otherwise.
 *
 * Without this rule a page of anonymous wrapper sections produces a landmark path of
 * `region > region > region`, which identifies nothing and moves whenever markup is reshuffled.
 * `<nav>`, `<aside>` and `<form>` are landmarks unconditionally under current HTML-AAM, so they
 * stay in the static table.
 */
const NAMED_SECTION_TAG = 'section';
const NAMED_SECTION_ROLE = 'region';

/** Roles for `<header>` and `<footer>`, which are landmarks only outside sectioning content. */
const SCOPED_ROLES: Readonly<Record<string, string>> = {
  header: 'banner',
  footer: 'contentinfo',
};

const SECTIONING_CONTENT = new Set(['article', 'aside', 'main', 'nav', 'section']);

function hasAccessibleNameAttribute(element: Element): boolean {
  return (
    element.hasAttribute('aria-label') ||
    element.hasAttribute('aria-labelledby') ||
    element.hasAttribute('title')
  );
}

/**
 * The element's computed ARIA role, or `'generic'` when it has none.
 *
 * `'generic'` rather than an empty string so the value satisfies the contract's
 * `NonEmptyString` and so two unroled `<div>`s compare equal on this signal rather than both
 * scoring against nothing.
 */
export function computeRole(element: Element): string {
  const explicit = element.getAttribute('role');
  if (explicit !== null) {
    // An author may supply a fallback list; the first token that is a real role wins. We do not
    // validate against the ARIA taxonomy, so effectively: the first token.
    const first = explicit.trim().split(/\s+/)[0];
    if (first !== undefined && first !== '') return first.toLowerCase();
  }

  const tag = element.tagName.toLowerCase();

  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    // `<input type="text" list="...">` is a combobox, not a textbox — a meaningful difference,
    // because the two are operated in completely different ways.
    if (INPUT_ROLES[type] === 'textbox' && element.hasAttribute('list')) return 'combobox';
    return INPUT_ROLES[type] ?? 'generic';
  }

  if (tag === 'a' || tag === 'area') {
    return element.hasAttribute('href') ? 'link' : 'generic';
  }

  const scoped = SCOPED_ROLES[tag];
  if (scoped !== undefined) {
    return isInsideSectioningContent(element) ? 'generic' : scoped;
  }

  if (tag === NAMED_SECTION_TAG) {
    return hasAccessibleNameAttribute(element) ? NAMED_SECTION_ROLE : 'generic';
  }

  return STATIC_ROLES[tag] ?? 'generic';
}

function isInsideSectioningContent(element: Element): boolean {
  let parent = element.parentElement;
  while (parent !== null) {
    if (SECTIONING_CONTENT.has(parent.tagName.toLowerCase())) return true;
    parent = parent.parentElement;
  }
  return false;
}
