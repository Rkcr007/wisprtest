/**
 * Route generalisation: `/orders/1841` → `/orders/:id`.
 *
 * A screen is a *kind* of page, not one instance of it. Indexing `/orders/1841`, `/orders/1842`
 * and `/orders/1843` as three screens would triple the memory snapshot, split the alias corpus
 * three ways, and still miss `/orders/1844`. Generalising the identifier makes them one screen
 * whose elements resolve on any order.
 *
 * ## What counts as an identifier
 *
 * The rules below are deliberately conservative and entirely generic — CLAUDE.md § "generic vs
 * per-application" forbids knowing that this customer's order ids are six digits. A segment is
 * generalised when its *shape* carries no meaning a human would speak: a number, a UUID, a hash,
 * a date, a long opaque token. Anything that reads like a word is left alone, because
 * `/orders/pending` is a route a tester says out loud and `/orders/:id` would erase it.
 *
 * False negatives are cheap — an extra screen in memory. False positives are not: collapsing
 * `/orders/pending` into `/orders/:id` merges two genuinely different screens and their elements
 * fight over the same keys. The rules err towards leaving a segment alone.
 */

/** A segment that is entirely digits: `1841`, `007`. */
const NUMERIC = /^\d+$/;

/** A UUID in any of the usual casings. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A bare hexadecimal blob: a git sha, a content hash, a Mongo object id. */
const HEX_BLOB = /^[0-9a-f]{12,}$/i;

/** ISO dates and their compact forms, which appear in report and archive routes. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_MONTH = /^\d{4}-\d{2}$/;

/**
 * A long opaque token: nanoid, ULID, base64url slug, `ord_9f2b1c…`.
 *
 * Requires both a digit and a length no product word reaches, so `subscriptions` and
 * `notifications` stay themselves while `01HQ3M7XK9` does not.
 */
const OPAQUE_TOKEN = /^(?=.*\d)[A-Za-z0-9_-]{10,}$/;

/**
 * A word with an id glued to it: `order-1841`, `invoice_20260725`, `user-3f2a`.
 *
 * The word half is kept, so `/orders/order-1841` becomes `/orders/order-:id` rather than
 * `/orders/:id` — the two are different shapes and merging them would lose that.
 */
const SUFFIXED_ID = /^([A-Za-z][A-Za-z-]*?)[-_](\d{2,}|[0-9a-f]{8,})$/;

/** The placeholder every generalised segment collapses to. */
export const ID_PLACEHOLDER = ':id';

/** The placeholder for date-shaped segments, kept distinct because it reads better in a console. */
export const DATE_PLACEHOLDER = ':date';

/**
 * Generalise one path segment, or return it unchanged.
 *
 * Exported for its own tests: the segment rules are where this module can go wrong, and a test
 * that can only reach them through a full URL is a test that reports the wrong thing.
 */
export function generalizeSegment(segment: string): string {
  const decoded = safeDecode(segment);

  if (decoded === '') return decoded;
  if (DATE.test(decoded) || YEAR_MONTH.test(decoded)) return DATE_PLACEHOLDER;
  if (NUMERIC.test(decoded)) return ID_PLACEHOLDER;
  if (UUID.test(decoded)) return ID_PLACEHOLDER;
  if (HEX_BLOB.test(decoded)) return ID_PLACEHOLDER;

  const suffixed = SUFFIXED_ID.exec(decoded);
  if (suffixed?.[1] !== undefined) return `${suffixed[1]}-${ID_PLACEHOLDER}`;

  if (OPAQUE_TOKEN.test(decoded)) return ID_PLACEHOLDER;

  return decoded;
}

/**
 * Derive a `RoutePattern` from a concrete URL or path.
 *
 * Query strings and fragments are dropped: they describe *which* data a screen is showing, and a
 * screen showing a different page of the same table is the same screen. Where a query parameter
 * genuinely changes what is reachable — a filter that reveals different controls — the state
 * fingerprint separates them, because the elements themselves differ.
 */
export function toRoutePattern(urlOrPath: string): string {
  const path = pathOf(urlOrPath);
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return '/';

  return `/${segments.map(generalizeSegment).join('/')}`;
}

/**
 * The path of a URL, with a trailing slash removed.
 *
 * `/orders` and `/orders/` are the same screen; leaving both in the frontier would index it
 * twice and give the second copy a duplicate state fingerprint.
 */
export function pathOf(urlOrPath: string): string {
  let path: string;
  try {
    path = new URL(urlOrPath).pathname;
  } catch {
    const [withoutHash = ''] = urlOrPath.split('#');
    const [withoutQuery = ''] = withoutHash.split('?');
    path = withoutQuery;
  }

  if (path === '') return '/';
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

/**
 * A human label for a screen, derived from its route pattern.
 *
 * Deliberately *not* the page's `<title>`. A title is content — "Order 1841 — Acme Industrial"
 * names a customer — and CLAUDE.md § "PII rule" is explicit that memory stores structure, never
 * content. The route pattern is structure, it is already generalised, and it is what a tester
 * navigating by voice is talking about anyway.
 *
 * `/` → `Home`, `/orders` → `Orders`, `/orders/:id` → `Orders detail`, `/orders/new` →
 * `Orders new`.
 */
export function screenLabel(routePattern: string): string {
  const segments = routePattern.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return 'Home';

  const words = segments.map((segment) =>
    // A placeholder segment says the screen is about one instance of the thing above it.
    segment.includes(':') ? 'detail' : segment.replace(/[-_]+/g, ' '),
  );

  const label = words.join(' ').trim();
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** A percent-encoded segment describes the same thing decoded, and reads better in a console. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
