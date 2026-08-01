import { describe, expect, it } from 'vitest';

import {
  entityNameFromPath,
  isIdentifierLike,
  normalizeFieldName,
  parseGroupedName,
  singularize,
  toEntityName,
} from './naming.js';

/**
 * The naming rules, which are where a schema silently goes wrong.
 *
 * None of these functions can fail loudly. A path that yields the wrong entity name splits one
 * entity into two; a field name that normalises wrongly merges two fields into one. Both produce
 * a schema that looks entirely reasonable and composes records the application rejects, which is
 * why the edge cases are enumerated here rather than left to the end-to-end suite to notice.
 */

describe('normalizeFieldName', () => {
  it('matches the spellings two channels use for the same field', () => {
    // The form says one, the payload says another, and they are one field.
    expect(normalizeFieldName('poNumber')).toBe(normalizeFieldName('po_number'));
    expect(normalizeFieldName('PO_NUMBER')).toBe(normalizeFieldName('poNumber'));
    expect(normalizeFieldName('due-date')).toBe(normalizeFieldName('dueDate'));
  });

  it('drops an identifier suffix so a picker and a foreign key agree', () => {
    expect(normalizeFieldName('accountId')).toBe('account');
    expect(normalizeFieldName('account_id')).toBe('account');
    expect(normalizeFieldName('AccountID')).toBe('account');
    expect(normalizeFieldName('account')).toBe('account');
  });

  it('only drops `id` where it is a word', () => {
    // The bug this guards: testing for the two trailing letters turns `paid` into `pa`, and two
    // fields that normalise to the same nonsense are merged into one.
    expect(normalizeFieldName('paid')).toBe('paid');
    expect(normalizeFieldName('valid')).toBe('valid');
    expect(normalizeFieldName('bid')).toBe('bid');
    expect(normalizeFieldName('rapid')).toBe('rapid');
    expect(normalizeFieldName('overpaid')).toBe('overpaid');

    // And distinct fields stay distinct.
    expect(normalizeFieldName('paid')).not.toBe(normalizeFieldName('pa'));
  });

  it('leaves a bare identifier alone — it is the key, not a reference to one', () => {
    expect(normalizeFieldName('id')).toBe('id');
  });

  it('keeps a group member distinct from the group', () => {
    expect(normalizeFieldName('lines.amount')).not.toBe(normalizeFieldName('lines'));
    expect(normalizeFieldName('lines.amount')).not.toBe(normalizeFieldName('lines.quantity'));
  });
});

describe('entityNameFromPath', () => {
  it('names the collection a path is about, whatever surrounds it', () => {
    expect(entityNameFromPath('/orders')).toBe('Order');
    expect(entityNameFromPath('/api/v2/orders')).toBe('Order');
    expect(entityNameFromPath('/api/v2/orders?limit=50')).toBe('Order');
    expect(entityNameFromPath('/api/v2/orders/1841')).toBe('Order');
    expect(entityNameFromPath('/api/v2/orders/:id')).toBe('Order');
    // The form on `/orders/new` is still about an order.
    expect(entityNameFromPath('/orders/new')).toBe('Order');
    // A nested collection is about the inner one.
    expect(entityNameFromPath('/api/v2/orders/1841/lines')).toBe('Line');
    expect(entityNameFromPath('/line_items')).toBe('LineItem');
  });

  it('declines rather than guessing when nothing names a collection', () => {
    expect(entityNameFromPath('/')).toBeNull();
    expect(entityNameFromPath('/api/v2')).toBeNull();
    expect(entityNameFromPath('/1841')).toBeNull();
  });
});

describe('singularize and toEntityName', () => {
  it('handles the productive English plurals and leaves the rest alone', () => {
    expect(singularize('orders')).toBe('order');
    expect(singularize('policies')).toBe('policy');
    expect(singularize('addresses')).toBe('address');
    expect(singularize('boxes')).toBe('box');
    // Words that merely end in `s`.
    expect(singularize('address')).toBe('address');
    expect(singularize('status')).toBe('status');
  });

  it('produces a stable PascalCase name from any separator style', () => {
    expect(toEntityName('line_items')).toBe('LineItem');
    expect(toEntityName('line-items')).toBe('LineItem');
    expect(toEntityName('lineItems')).toBe('LineItem');
  });
});

describe('isIdentifierLike', () => {
  it('separates a vocabulary from a picker over another collection', () => {
    // Values a tester says out loud.
    expect(isIdentifierLike(['pending', 'approved', 'shipped'])).toBe(false);
    expect(isIdentifierLike(['net15', 'net30', 'net60'])).toBe(false);
    expect(isIdentifierLike(['Pending approval', 'Approved'])).toBe(false);

    // Keys, which change as rows are added and must never be frozen into memory as an enum.
    expect(isIdentifierLike(['ACC-1001', 'ACC-1002'])).toBe(true);
    expect(isIdentifierLike(['1841', '1842'])).toBe(true);
    expect(isIdentifierLike(['3f2504e0-4f89-41d3-9a0c-0305e82c3301'])).toBe(true);
  });

  it('is false for an empty set, which declares nothing either way', () => {
    expect(isIdentifierLike([])).toBe(false);
  });
});

describe('parseGroupedName', () => {
  it('recognises the conventions every server framework parses', () => {
    expect(parseGroupedName('lines[0][amount]')).toEqual({ group: 'lines', member: 'amount' });
    expect(parseGroupedName('lines[0].amount')).toEqual({ group: 'lines', member: 'amount' });
    expect(parseGroupedName('line_items[][sku]')).toEqual({ group: 'line_items', member: 'sku' });
  });

  it('returns null for a name that is not a group member', () => {
    expect(parseGroupedName('customer')).toBeNull();
    expect(parseGroupedName('lines')).toBeNull();
    expect(parseGroupedName('lines[0]')).toBeNull();
  });
});
