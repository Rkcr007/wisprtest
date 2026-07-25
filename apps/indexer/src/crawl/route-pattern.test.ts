import { describe, expect, it } from 'vitest';

import { generalizeSegment, pathOf, screenLabel, toRoutePattern } from './route-pattern.js';

describe('generalizeSegment', () => {
  it('generalises what carries no meaning a tester would speak', () => {
    expect(generalizeSegment('1841')).toBe(':id');
    expect(generalizeSegment('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(':id');
    expect(generalizeSegment('9f2b1c8ad0e4f7')).toBe(':id');
    expect(generalizeSegment('01HQ3M7XK9ABCD')).toBe(':id');
    expect(generalizeSegment('2026-07-25')).toBe(':date');
    expect(generalizeSegment('2026-07')).toBe(':date');
  });

  it('keeps segments that a tester says out loud', () => {
    // `/orders/pending` is a screen somebody navigates to by name. Collapsing it into
    // `/orders/:id` would merge two different screens and make their elements fight for keys.
    for (const segment of ['orders', 'pending', 'new', 'settings', 'export', 'subscriptions']) {
      expect(generalizeSegment(segment), segment).toBe(segment);
    }
  });

  it('keeps the word half of a word-plus-id segment', () => {
    expect(generalizeSegment('order-1841')).toBe('order-:id');
    expect(generalizeSegment('invoice_20260725')).toBe('invoice-:id');
  });

  it('decodes before deciding', () => {
    expect(generalizeSegment('order%20detail')).toBe('order detail');
  });
});

describe('toRoutePattern', () => {
  it('generalises identifiers inside a full URL', () => {
    expect(toRoutePattern('https://app.example/orders/1841')).toBe('/orders/:id');
    expect(toRoutePattern('/orders/1841/lines/7')).toBe('/orders/:id/lines/:id');
  });

  it('drops the query and the fragment', () => {
    // A different page of the same table is the same screen. Where a query genuinely changes what
    // is reachable, the state fingerprint separates the two — the elements themselves differ.
    expect(toRoutePattern('https://app.example/orders?status=pending&page=3')).toBe('/orders');
    expect(toRoutePattern('/orders#top')).toBe('/orders');
  });

  it('treats the root as the root', () => {
    expect(toRoutePattern('https://app.example')).toBe('/');
    expect(toRoutePattern('/')).toBe('/');
  });
});

describe('pathOf', () => {
  it('drops a trailing slash so one screen is not indexed twice', () => {
    expect(pathOf('https://app.example/orders/')).toBe('/orders');
    expect(pathOf('/orders/')).toBe('/orders');
    expect(pathOf('/')).toBe('/');
  });
});

describe('screenLabel', () => {
  it('names a screen from its route, never from its title', () => {
    // A page title reads "Northwind — Order 1841 — Acme Industrial", which names a customer.
    // CLAUDE.md § "PII rule": memory stores structure, never content.
    expect(screenLabel('/')).toBe('Home');
    expect(screenLabel('/orders')).toBe('Orders');
    expect(screenLabel('/orders/:id')).toBe('Orders detail');
    expect(screenLabel('/orders/new')).toBe('Orders new');
    expect(screenLabel('/admin/user-roles')).toBe('Admin user roles');
  });
});
