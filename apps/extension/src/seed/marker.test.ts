import { beforeEach, describe, expect, it } from 'vitest';

import { findSeedMarks } from './marker.js';

/**
 * Finding a seeded record on screen — by the link that points at it, never by its text.
 *
 * The near misses are the point. `ORD-49` must not match `ORD-490`, a mention of the reference in
 * body copy must not become an outline, and a link that is off-screen or collapsed must not put a
 * floating box over unrelated content.
 */

const VIEWPORT = { width: 1280, height: 800 };

/**
 * happy-dom returns a zero rect for everything, so a visible element is one we give a rect to.
 * Stubbing the geometry rather than the query is deliberate: the selection logic is what is under
 * test, and it is the part that would delete the wrong row if it were wrong.
 */
function withRect(element: Element, rect: Partial<DOMRect>): void {
  const full = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    ...rect,
  };
  element.getBoundingClientRect = () => full as DOMRect;
}

/** A rect that is on screen: 200×32 at (40, 120). */
const ON_SCREEN = {
  x: 40,
  y: 120,
  left: 40,
  top: 120,
  right: 240,
  bottom: 152,
  width: 200,
  height: 32,
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('a link to a seeded record', () => {
  it('is found by the path segment that names it', () => {
    document.body.innerHTML = `
      <a id="row" href="/orders/ORD-4903">Acme Industrial</a>
    `;
    withRect(document.querySelector('#row') as Element, ON_SCREEN);

    const marks = findSeedMarks({
      document,
      externalRefs: ['ORD-4903'],
      viewport: VIEWPORT,
    });

    expect(marks).toHaveLength(1);
    expect(marks[0]?.externalRef).toBe('ORD-4903');
    expect(marks[0]?.rect).toEqual({ x: 40, y: 120, width: 200, height: 32 });
  });

  it('matches case-insensitively, because a URL is not the ledger', () => {
    document.body.innerHTML = `<a id="row" href="/orders/ord-4903">Acme</a>`;
    withRect(document.querySelector('#row') as Element, ON_SCREEN);

    const marks = findSeedMarks({ document, externalRefs: ['ORD-4903'], viewport: VIEWPORT });
    // The mark carries the ledger's spelling, not the URL's.
    expect(marks[0]?.externalRef).toBe('ORD-4903');
  });

  it('finds it on a detail page as readily as in a list row', () => {
    document.body.innerHTML = `
      <nav><a id="crumb" href="/orders">Orders</a></nav>
      <a id="self" href="/orders/ORD-4903/edit">Edit</a>
    `;
    withRect(document.querySelector('#crumb') as Element, ON_SCREEN);
    withRect(document.querySelector('#self') as Element, ON_SCREEN);

    const marks = findSeedMarks({ document, externalRefs: ['ORD-4903'], viewport: VIEWPORT });
    expect(marks).toHaveLength(1);
  });
});

describe('what it refuses to mark', () => {
  it('does not match a reference that is a prefix of the segment', () => {
    document.body.innerHTML = `<a id="row" href="/orders/ORD-4903">Acme</a>`;
    withRect(document.querySelector('#row') as Element, ON_SCREEN);

    // Segment equality, not substring: `ORD-49` is a different record from `ORD-4903`.
    expect(findSeedMarks({ document, externalRefs: ['ORD-49'], viewport: VIEWPORT })).toEqual([]);
  });

  it('does not read text — a row that merely mentions the reference is not the row', () => {
    document.body.innerHTML = `
      <p id="note">Superseded by ORD-4903</p>
      <a id="other" href="/orders/ORD-1111">Other order</a>
    `;
    withRect(document.querySelector('#note') as Element, ON_SCREEN);
    withRect(document.querySelector('#other') as Element, ON_SCREEN);

    expect(findSeedMarks({ document, externalRefs: ['ORD-4903'], viewport: VIEWPORT })).toEqual([]);
  });

  it('skips a link with no box — collapsed, hidden, or recycled out of a virtual list', () => {
    document.body.innerHTML = `<a id="row" href="/orders/ORD-4903">Acme</a>`;
    withRect(document.querySelector('#row') as Element, { width: 0, height: 0 });

    expect(findSeedMarks({ document, externalRefs: ['ORD-4903'], viewport: VIEWPORT })).toEqual([]);
  });

  it('skips a link scrolled out of the viewport', () => {
    document.body.innerHTML = `<a id="row" href="/orders/ORD-4903">Acme</a>`;
    withRect(document.querySelector('#row') as Element, {
      x: 40,
      y: 2400,
      left: 40,
      top: 2400,
      right: 240,
      bottom: 2432,
      width: 200,
      height: 32,
    });

    expect(findSeedMarks({ document, externalRefs: ['ORD-4903'], viewport: VIEWPORT })).toEqual([]);
  });

  it('ignores a non-http scheme rather than parsing it as a path', () => {
    document.body.innerHTML = `<a id="row" href="javascript:void('ORD-4903')">Run</a>`;
    withRect(document.querySelector('#row') as Element, ON_SCREEN);

    expect(findSeedMarks({ document, externalRefs: ['ORD-4903'], viewport: VIEWPORT })).toEqual([]);
  });

  it('returns nothing when the ledger is empty, without touching the document', () => {
    document.body.innerHTML = `<a id="row" href="/orders/ORD-4903">Acme</a>`;
    expect(findSeedMarks({ document, externalRefs: [], viewport: VIEWPORT })).toEqual([]);
  });
});

describe('one record, one mark', () => {
  it('marks the first visible link when several point at the same record', () => {
    document.body.innerHTML = `
      <a id="first" href="/orders/ORD-4903">Acme Industrial</a>
      <a id="second" href="/orders/ORD-4903">View detail</a>
    `;
    withRect(document.querySelector('#first') as Element, ON_SCREEN);
    withRect(document.querySelector('#second') as Element, {
      ...ON_SCREEN,
      y: 400,
      top: 400,
      bottom: 432,
    });

    const marks = findSeedMarks({ document, externalRefs: ['ORD-4903'], viewport: VIEWPORT });
    // Two outlines for one record would read as two records.
    expect(marks).toHaveLength(1);
    expect(marks[0]?.rect.y).toBe(120);
  });

  it('marks each record of a multi-entity graph separately', () => {
    document.body.innerHTML = `
      <a id="acct" href="/accounts/ACC-1001">Acme Industrial</a>
      <a id="order" href="/orders/ORD-4903">Order 4903</a>
    `;
    withRect(document.querySelector('#acct') as Element, ON_SCREEN);
    withRect(document.querySelector('#order') as Element, {
      ...ON_SCREEN,
      y: 200,
      top: 200,
      bottom: 232,
    });

    const marks = findSeedMarks({
      document,
      externalRefs: ['ACC-1001', 'ORD-4903'],
      viewport: VIEWPORT,
    });
    expect(marks.map((mark) => mark.externalRef).sort()).toEqual(['ACC-1001', 'ORD-4903']);
  });
});

describe('the host document', () => {
  it('is never mutated — the marks are drawn elsewhere', () => {
    document.body.innerHTML = `<a id="row" href="/orders/ORD-4903">Acme</a>`;
    const row = document.querySelector('#row') as Element;
    withRect(row, ON_SCREEN);
    const before = document.body.innerHTML;

    findSeedMarks({ document, externalRefs: ['ORD-4903'], viewport: VIEWPORT });

    // No class, no attribute, no inline style. Phase 6's guarantee holds.
    expect(document.body.innerHTML).toBe(before);
    expect(row.getAttribute('style')).toBeNull();
    expect(row.className).toBe('');
  });
});
