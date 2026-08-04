/**
 * Showing the tester which records WisprTest created.
 *
 * docs/TEST-DATA-ENGINE.md § 6, step 5: "Show the created record with a distinct visual treatment
 * in the app under test." It is the step that closes the loop honestly. A tester looking at a list
 * of forty orders should be able to see at a glance which one exists because they asked for it —
 * otherwise seeded data is indistinguishable from the customer's own, which is fine for the
 * application and terrible for the person testing it.
 *
 * ## Found by link, not by text
 *
 * A record is located by the thing that structurally *points at* it: an anchor whose path carries
 * the record's own external reference. `/orders/ORD-4903` is the row for `ORD-4903`, in a list or
 * on a detail page, and no amount of similar-looking text elsewhere changes that.
 *
 * The alternative — scanning the document for text equal to the reference — was rejected for the
 * same reason the gateway's `locateRecordControl` scopes a delete to the row that links to the
 * record's path: identifying a record by what it *reads* means walking every text node in a
 * customer's page, and getting it wrong on a page that happens to mention the string. Matching a
 * path segment is cheap, exact, and reads no content.
 *
 * ## What it does not touch
 *
 * The host DOM. Nothing here sets a style, adds a class, or attaches an attribute to an element of
 * the application under test — the marks are drawn in the HUD's own shadow root, over the top. The
 * Phase 6 guarantee is that mounting the HUD leaves `document.body` exactly as the application left
 * it, and a decoration that mutated the page to highlight a row would break it the first time a
 * customer's app diffed its own DOM.
 *
 * The external references themselves are records WisprTest asked the gateway to create and already
 * holds in its ledger view. Nothing is read out of the page and nothing is sent anywhere — this
 * module only ever answers "where on screen is the record I already know about".
 */

/** A seeded record found on screen, and where to draw over it. */
export interface SeedMark {
  /** The record's own identifier, e.g. `ORD-4903`. */
  readonly externalRef: string;
  /** Viewport rect, for a `position: fixed` overlay. */
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/**
 * Path segments of a URL, lowercased.
 *
 * Relative and absolute hrefs both go through `URL`, resolved against the document's own base, so
 * `/orders/ORD-4903`, `orders/ORD-4903` and a fully qualified URL all yield the same segments. An
 * href the URL parser rejects — `javascript:`, a bare `#`, a malformed value — yields none, and the
 * anchor is simply not a match.
 */
function pathSegments(href: string, base: string): readonly string[] {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return [];
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return [];
  return url.pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => decodeURIComponent(segment).toLowerCase());
}

/**
 * Whether an element is worth drawing over.
 *
 * A zero-sized box is a link that is scrolled out of a virtualised list, inside a collapsed
 * section, or `display: none`. Drawing a mark on it would put a floating outline over unrelated
 * content at the top-left corner of the viewport.
 */
function isVisible(rect: DOMRect, viewport: { width: number; height: number }): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  return (
    rect.bottom > 0 && rect.right > 0 && rect.top < viewport.height && rect.left < viewport.width
  );
}

export interface FindSeedMarksOptions {
  readonly document: Document;
  /** External references of records that currently exist, from the ledger. */
  readonly externalRefs: readonly string[];
  readonly viewport: { readonly width: number; readonly height: number };
}

/**
 * Locate the on-screen anchors for a set of seeded records.
 *
 * One pass over the document's anchors, at most one mark per record: a list row and a breadcrumb
 * can both link to the same order, and two outlines on one screen would read as two records. The
 * first visible match wins, which in document order is the one furthest up the page.
 */
export function findSeedMarks(options: FindSeedMarksOptions): readonly SeedMark[] {
  const { document: doc, externalRefs, viewport } = options;
  if (externalRefs.length === 0) return [];

  const wanted = new Map<string, string>();
  for (const ref of externalRefs) {
    const normalized = ref.toLowerCase();
    if (normalized !== '') wanted.set(normalized, ref);
  }
  if (wanted.size === 0) return [];

  const base = doc.baseURI;
  const marks: SeedMark[] = [];
  const seen = new Set<string>();

  for (const anchor of doc.querySelectorAll('a[href]')) {
    if (seen.size === wanted.size) break;

    const href = anchor.getAttribute('href');
    if (href === null || href === '') continue;

    for (const segment of pathSegments(href, base)) {
      const ref = wanted.get(segment);
      if (ref === undefined || seen.has(segment)) continue;

      const rect = anchor.getBoundingClientRect();
      if (!isVisible(rect, viewport)) continue;

      seen.add(segment);
      marks.push({
        externalRef: ref,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      });
      break;
    }
  }

  return marks;
}
