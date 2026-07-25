import type { ElementFingerprint } from 'protocol';

/**
 * Element keys: `screen.component.element`, per CLAUDE.md § "Conventions".
 *
 * These ids are read in bug reports, spoken about in standups and pasted into the console, so
 * they are built to be legible rather than unique-by-construction: `orders.filter.pending`, not
 * `orders.c3f1.e17`. Uniqueness within a screen is enforced by the database
 * (`elements_screen_key_key`), and by the ordinal suffix this module adds when two elements
 * would otherwise collide.
 *
 * Every part is derived from what was observed — route, landmark ancestry, accessible name — and
 * nothing is configured per application. The accessible name arrives already redacted from
 * `packages/fingerprint`, so a key can never carry a customer's data: an input labelled with
 * somebody's email address yields `.email`, never the address.
 */

/** Longest any one segment may be, so a key stays readable in a table. */
const MAX_SEGMENT_LENGTH = 40;

/** Route segments used to name the screen. Two is enough to separate `/orders` from `/orders/new`. */
const MAX_SCREEN_SEGMENTS = 2;

/**
 * Slugify text into one element-key segment: lowercase, alphanumeric, `-` between words.
 *
 * Returns an empty string when there is nothing usable left, which is the caller's signal to
 * fall back rather than emit a key that fails the contract's pattern.
 */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    // Accents are dropped rather than transliterated: `Rückgabe` becomes `ruckgabe`, which is
    // stable and greppable. Transliteration is language-specific and this code is not.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (slug.length <= MAX_SEGMENT_LENGTH) return slug;
  return slug.slice(0, MAX_SEGMENT_LENGTH).replace(/-+$/, '');
}

/**
 * The screen segment, derived from the route pattern.
 *
 * A placeholder segment contributes the word `detail` rather than its own text — `/orders/:id` is
 * named for the orders it shows, not for the identifier it takes. Contributing *something* matters:
 * dropping the placeholder entirely would name `/orders` and `/orders/:id` both `orders`, and two
 * different screens sharing a key prefix is exactly the ambiguity these ids exist to remove.
 *
 * The root route is `home`, which is what a tester calls it.
 */
export function screenSegment(routePattern: string): string {
  const segments = routePattern.split('/').filter((segment) => segment !== '');

  const named = segments
    .map((segment) => (segment.includes(':') ? 'detail' : slugify(segment)))
    .filter((segment) => segment !== '')
    .slice(0, MAX_SCREEN_SEGMENTS);

  if (named.length === 0) return 'home';
  return trimSegment(named.join('-'));
}

/**
 * The component segment, derived from the innermost landmark the element sits in.
 *
 * `region:orders` names the region; a bare `main` names the landmark role. An element outside any
 * landmark belongs to the page itself, which is what `page` means here — not "unknown".
 */
export function componentSegment(landmarkPath: readonly string[]): string {
  const innermost = landmarkPath.at(-1);
  if (innermost === undefined) return 'page';

  // Landmark entries are `role` or `role:accessible-name`; the name is the more specific half.
  const [role = '', ...rest] = innermost.split(':');
  const label = rest.join(':').trim();
  return slugify(label) || slugify(role) || 'page';
}

/**
 * The element segment: its accessible name, or its role when it has no name.
 *
 * A stable attribute is preferred over both when one is present, because a `data-testid` is a
 * name the application's own authors chose for the element and it survives copy changes that a
 * label does not.
 */
export function elementSegment(fingerprint: ElementFingerprint): string {
  const testId =
    fingerprint.stableAttributes['data-testid'] ??
    fingerprint.stableAttributes['data-test-id'] ??
    fingerprint.stableAttributes['data-qa'] ??
    fingerprint.stableAttributes.name;

  const candidates = [testId ?? '', fingerprint.accessibleNameRedacted, fingerprint.role];
  for (const candidate of candidates) {
    const slug = slugify(candidate);
    if (slug !== '') return slug;
  }
  return 'element';
}

/**
 * Mints `screen.component.element` keys that are unique within one screen.
 *
 * Collisions are real and frequent — a table of twenty rows each with a "View" link — so the
 * second and subsequent occurrences take an ordinal suffix: `orders.list.view`,
 * `orders.list.view-2`, `orders.list.view-3`. The suffix follows document order, which is stable
 * across crawls of an unchanged page and is the same order a tester counts in when they say
 * "the third one".
 */
export class ElementKeyMinter {
  readonly #screen: string;
  readonly #taken = new Map<string, number>();

  constructor(routePattern: string) {
    this.#screen = screenSegment(routePattern);
  }

  mint(fingerprint: ElementFingerprint): string {
    const base = `${this.#screen}.${componentSegment(fingerprint.landmarkPath)}.${elementSegment(fingerprint)}`;

    const seen = this.#taken.get(base) ?? 0;
    this.#taken.set(base, seen + 1);
    if (seen === 0) return base;

    // The suffix lands on the element segment, not the whole key, so the screen and component
    // stay meaningful: `orders.list.view-2`, never `orders.list.view.2`.
    return `${base}-${String(seen + 1)}`;
  }
}

function trimSegment(segment: string): string {
  if (segment.length <= MAX_SEGMENT_LENGTH) return segment;
  return segment.slice(0, MAX_SEGMENT_LENGTH).replace(/-+$/, '');
}
