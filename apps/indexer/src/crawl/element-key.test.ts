import { ElementKey } from 'protocol';
import type { ElementFingerprint } from 'protocol';
import { describe, expect, it } from 'vitest';

import {
  componentSegment,
  ElementKeyMinter,
  elementSegment,
  screenSegment,
  slugify,
} from './element-key.js';

const fingerprint = (overrides: Partial<ElementFingerprint> = {}): ElementFingerprint => ({
  role: 'button',
  tagName: 'button',
  accessibleNameHash: 'a'.repeat(64),
  accessibleNameRedacted: 'Approve order',
  landmarkPath: ['main', 'region:orders'],
  stableAttributes: {},
  ordinal: 0,
  textShingleHash: 'b'.repeat(64),
  bbox: { x: 0.1, y: 0.2, width: 0.1, height: 0.05 },
  ...overrides,
});

describe('slugify', () => {
  it('produces one legible key segment', () => {
    expect(slugify('Approve order')).toBe('approve-order');
    expect(slugify('  Sign  in!  ')).toBe('sign-in');
    expect(slugify('Rückgabe')).toBe('ruckgabe');
  });

  it('returns empty when nothing usable is left, so the caller can fall back', () => {
    expect(slugify('—')).toBe('');
    expect(slugify('')).toBe('');
  });
});

describe('the three segments', () => {
  it('names the screen from the route, without repeating an identifier', () => {
    // A placeholder contributes `detail` rather than nothing: `/orders` and `/orders/:id` are
    // different screens, and keys that both began `orders.` would be the ambiguity these ids
    // exist to remove.
    expect(screenSegment('/orders/:id')).toBe('orders-detail');
    expect(screenSegment('/orders/new')).toBe('orders-new');
    expect(screenSegment('/orders')).toBe('orders');
    expect(screenSegment('/')).toBe('home');
  });

  it('names the component from the innermost landmark', () => {
    expect(componentSegment(['main', 'region:orders'])).toBe('orders');
    expect(componentSegment(['main'])).toBe('main');
    expect(componentSegment([])).toBe('page');
  });

  it('prefers a stable attribute over a label, and a label over a role', () => {
    expect(
      elementSegment(fingerprint({ stableAttributes: { 'data-testid': 'order-approve' } })),
    ).toBe('order-approve');
    expect(elementSegment(fingerprint())).toBe('approve-order');
    expect(elementSegment(fingerprint({ accessibleNameRedacted: '' }))).toBe('button');
  });

  it('cannot leak a redacted value into a key', () => {
    // The name arrives already scrubbed from packages/fingerprint; the key is built from that.
    expect(elementSegment(fingerprint({ accessibleNameRedacted: '[email]' }))).toBe('email');
  });
});

describe('ElementKeyMinter', () => {
  it('mints keys that satisfy the contract', () => {
    const minter = new ElementKeyMinter('/orders/:id');
    const key = minter.mint(fingerprint());

    expect(key).toBe('orders-detail.orders.approve-order');
    expect(ElementKey.safeParse(key).success).toBe(true);
  });

  it('gives repeated controls an ordinal suffix in document order', () => {
    // Twenty rows each with a "View" link is the normal case, not an edge case.
    const minter = new ElementKeyMinter('/orders');
    const view = fingerprint({ role: 'link', tagName: 'a', accessibleNameRedacted: 'View' });

    expect(minter.mint(view)).toBe('orders.orders.view');
    expect(minter.mint(view)).toBe('orders.orders.view-2');
    expect(minter.mint(view)).toBe('orders.orders.view-3');
  });

  it('keeps every suffixed key valid, since the database enforces the shape', () => {
    const minter = new ElementKeyMinter('/orders');
    const keys = Array.from({ length: 12 }, () => minter.mint(fingerprint()));

    expect(new Set(keys).size).toBe(12);
    for (const key of keys) expect(ElementKey.safeParse(key).success, key).toBe(true);
  });

  it('separates elements that sit in different landmarks', () => {
    const minter = new ElementKeyMinter('/settings');
    const save = fingerprint({
      accessibleNameRedacted: 'Save',
      landmarkPath: ['main', 'region:notifications'],
    });
    const purge = fingerprint({
      accessibleNameRedacted: 'Save',
      landmarkPath: ['main', 'region:danger zone'],
    });

    expect(minter.mint(save)).toBe('settings.notifications.save');
    expect(minter.mint(purge)).toBe('settings.danger-zone.save');
  });
});
