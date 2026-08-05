import { ElementKey, StructuralDiff, type ElementFingerprint } from 'protocol';
import { describe, expect, it } from 'vitest';

import { computeDiff, type ObservedElement, type StoredElement } from './diff.js';

/**
 * How a page's changes are described to the person deciding whether to accept them.
 *
 * The categories are the whole point. A reviewer reading "removed: Approve / added: Confirm" is
 * being asked to approve deleting a control that is still there, and has no way to see that every
 * phrase pointing at it is about to be dropped. The same change reported as a rename is a
 * one-line decision.
 *
 * So these assert classification rather than counts, and each case is one of the four things that
 * actually happens to a control between deployments.
 */

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const NAME_A = 'a'.repeat(64);
const NAME_B = 'b'.repeat(64);

function fingerprint(overrides: Partial<ElementFingerprint> = {}): ElementFingerprint {
  return {
    role: 'button',
    tagName: 'button',
    accessibleNameHash: NAME_A,
    accessibleNameRedacted: 'Approve',
    landmarkPath: ['main', 'region:orders'],
    stableAttributes: { 'data-testid': 'order-approve' },
    ordinal: 0,
    textShingleHash: 'c'.repeat(64),
    bbox: { x: 0.1, y: 0.2, width: 0.1, height: 0.04 },
    ...overrides,
  };
}

function stored(elementKey: string, overrides: Partial<ElementFingerprint> = {}): StoredElement {
  return { id: UUID, elementKey, fingerprint: fingerprint(overrides) };
}

function observed(marker: number, overrides: Partial<ElementFingerprint> = {}): ObservedElement {
  return { marker, fingerprint: fingerprint(overrides) };
}

describe('classifying what changed', () => {
  it('reports nothing when everything matched unchanged', () => {
    const diff = computeDiff({
      stored: [stored('orders.orders.approve')],
      observed: [observed(0)],
      match: {
        matched: [{ elementKey: 'orders.orders.approve', marker: 0, score: 0.98 }],
        missing: [],
        unmatchedMarkers: [],
      },
    });

    expect(diff).toEqual({
      added: [],
      removed: [],
      moved: [],
      renamed: [],
      schemaChanges: [],
    });
  });

  it('reports a relabelled control as a rename, not a delete plus an add', () => {
    // The case that motivates score-based matching. The element key is minted from the accessible
    // name when there is no test id, so this element's key would change too — and matching by key
    // would produce exactly the misleading pair this avoids.
    const diff = computeDiff({
      stored: [stored('orders.orders.approve')],
      observed: [
        observed(0, { accessibleNameHash: NAME_B, accessibleNameRedacted: 'Confirm order' }),
      ],
      match: {
        matched: [{ elementKey: 'orders.orders.approve', marker: 0, score: 0.79 }],
        missing: [],
        unmatchedMarkers: [],
      },
    });

    expect(diff.removed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.renamed).toEqual([
      {
        elementKey: 'orders.orders.approve',
        elementId: UUID,
        fromNameHash: NAME_A,
        toNameHash: NAME_B,
        toNameRedacted: 'Confirm order',
        matchConfidence: 0.79,
      },
    ]);
  });

  it('reports a control that changed ancestry as a move', () => {
    const diff = computeDiff({
      stored: [stored('orders.orders.approve')],
      observed: [observed(0, { landmarkPath: ['main', 'region:actions'] })],
      match: {
        matched: [{ elementKey: 'orders.orders.approve', marker: 0, score: 0.86 }],
        missing: [],
        unmatchedMarkers: [],
      },
    });

    expect(diff.moved).toEqual([
      {
        elementKey: 'orders.orders.approve',
        elementId: UUID,
        fromLandmarkPath: ['main', 'region:orders'],
        toLandmarkPath: ['main', 'region:actions'],
        matchConfidence: 0.86,
      },
    ]);
    expect(diff.renamed).toEqual([]);
  });

  it('reports a control that was both relabelled and moved as both', () => {
    // Collapsing this to one category would hide half of what changed from the person deciding
    // whether the change is expected.
    const diff = computeDiff({
      stored: [stored('orders.orders.approve')],
      observed: [
        observed(0, {
          accessibleNameHash: NAME_B,
          accessibleNameRedacted: 'Confirm',
          landmarkPath: ['main', 'region:actions'],
        }),
      ],
      match: {
        matched: [{ elementKey: 'orders.orders.approve', marker: 0, score: 0.71 }],
        missing: [],
        unmatchedMarkers: [],
      },
    });

    expect(diff.moved).toHaveLength(1);
    expect(diff.renamed).toHaveLength(1);
  });

  it('reports what nothing on the page could be, and what memory never had', () => {
    const diff = computeDiff({
      stored: [stored('orders.orders.approve'), stored('orders.orders.draft')],
      // No test id, so the key comes from the accessible name — the same precedence
      // `elementSegment` applies when a crawl mints one.
      observed: [
        observed(7, {
          accessibleNameRedacted: 'Archive',
          landmarkPath: ['main'],
          stableAttributes: {},
        }),
      ],
      match: {
        matched: [],
        missing: ['orders.orders.approve', 'orders.orders.draft'],
        unmatchedMarkers: [7],
      },
    });

    expect(diff.removed.map((entry) => entry.elementKey)).toEqual([
      'orders.orders.approve',
      'orders.orders.draft',
    ]);
    expect(diff.added).toEqual([
      {
        elementKey: 'main.archive.new',
        role: 'button',
        accessibleNameRedacted: 'Archive',
        landmarkPath: ['main'],
      },
    ]);
  });

  it('names an addition the way a crawl would name it', () => {
    // `elementSegment` prefers a test id over the accessible name, and a provisional key has to
    // follow that precedence or additions would read differently from every other key on the
    // screen — the reviewer would have to learn two naming schemes.
    const diff = computeDiff({
      stored: [],
      observed: [observed(0, { accessibleNameRedacted: 'Archive' })],
      match: { matched: [], missing: [], unmatchedMarkers: [0] },
    });

    expect(diff.added[0]?.elementKey).toBe('orders.order-approve.new');
  });

  it('mints a provisional key the contract will accept', () => {
    // `ElementAddition.elementKey` is an `ElementKey`, which the database also constrains. A key
    // this pass invents has to satisfy that pattern or the whole diff fails to store — and it
    // would fail at the end of a reconcile, after the browser work was already paid for.
    const diff = computeDiff({
      stored: [],
      observed: [
        observed(0, {
          accessibleNameRedacted: 'Save & continue…',
          landmarkPath: ['region:Order Details'],
          stableAttributes: {},
        }),
        observed(1, {
          accessibleNameRedacted: '',
          role: 'checkbox',
          landmarkPath: [],
          stableAttributes: {},
        }),
      ],
      match: { matched: [], missing: [], unmatchedMarkers: [0, 1] },
    });

    for (const addition of diff.added) {
      expect(ElementKey.safeParse(addition.elementKey).success).toBe(true);
    }
    expect(diff.added[0]?.elementKey).toBe('order-details.save-continue.new');
    // No name and no landmark still has to produce something legal.
    expect(diff.added[1]?.elementKey).toBe('page.checkbox.new');
  });

  it('produces a diff the contract accepts', () => {
    const diff = computeDiff({
      stored: [stored('orders.orders.approve')],
      observed: [observed(0, { accessibleNameHash: NAME_B })],
      match: {
        matched: [{ elementKey: 'orders.orders.approve', marker: 0, score: 0.8 }],
        missing: [],
        unmatchedMarkers: [],
      },
    });

    expect(StructuralDiff.safeParse(diff).success).toBe(true);
  });
});
