import { describe, expect, it } from 'vitest';

import { findDeleteFlows, isRemovalName, type DeleteFlowCandidate } from './delete-flow.js';

/**
 * The delete-flow search.
 *
 * Worth its own suite because both of its failure modes are expensive and neither is loud. A
 * false negative tells a tester a record cannot be reverted when it can, and they stop seeding.
 * A false positive promises a revert that will not happen, or — worse — points the revert at a
 * bulk control that removes rows nobody approved.
 */

function candidate(overrides: Partial<DeleteFlowCandidate> = {}): DeleteFlowCandidate {
  return {
    elementKey: 'orders.form.order-delete',
    routePattern: '/orders',
    accessibleNameRedacted: 'Delete',
    role: 'button',
    ...overrides,
  };
}

describe('what counts as a removal', () => {
  it('accepts a bare verb and a verb naming its object', () => {
    for (const name of [
      'Delete',
      'Remove',
      'Delete order',
      'Remove this invoice',
      'Discard draft',
    ]) {
      expect(isRemovalName(name), name).toBe(true);
    }
  });

  it('rejects a verb that only appears inside a longer instruction', () => {
    // Bulk controls are the dangerous case: activating one as an inverse operation would remove
    // records nobody approved creating.
    for (const name of [
      'Delete all completed orders from last quarter',
      'Undelete',
      'Deletion policy',
      'Confirm before you delete anything',
    ]) {
      expect(isRemovalName(name), name).toBe(false);
    }
  });

  it('rejects verbs that sound destructive and remove nothing', () => {
    // Both leave the record in place. Reporting either as a revert would tell a tester their
    // seeded row is gone while it is still in the list, still affecting the next assertion.
    for (const name of ['Archive', 'Archive order', 'Cancel', 'Cancel order']) {
      expect(isRemovalName(name), name).toBe(false);
    }
  });
});

describe('attributing a flow to an entity', () => {
  it('takes the entity from the route, as the schema observers do', () => {
    const flows = findDeleteFlows([
      candidate(),
      candidate({
        elementKey: 'invoices-detail.invoice.remove',
        routePattern: '/invoices/:id',
        accessibleNameRedacted: 'Remove invoice',
      }),
    ]);

    expect(Object.fromEntries(flows)).toEqual({
      Order: 'orders.form.order-delete',
      Invoice: 'invoices-detail.invoice.remove',
    });
  });

  it('keeps the first of a list of identical row controls', () => {
    // A list renders one per row and they are indistinguishable. Which one is indexed does not
    // matter: the revert aims at a record by its own path, not by which button was recorded.
    const flows = findDeleteFlows([
      candidate({ elementKey: 'orders.form.order-delete' }),
      candidate({ elementKey: 'orders.form.order-delete-2' }),
      candidate({ elementKey: 'orders.form.order-delete-3' }),
    ]);

    expect(flows.get('Order')).toBe('orders.form.order-delete');
  });

  it('ignores text that is not an activatable control', () => {
    const flows = findDeleteFlows([
      candidate({ role: 'cell', accessibleNameRedacted: 'Deleted' }),
      candidate({ role: 'status', accessibleNameRedacted: 'Delete' }),
    ]);

    expect(flows.size).toBe(0);
  });

  it('finds nothing when the application names removal in its own words', () => {
    // The honest outcome. The preview says the record cannot be reverted, before it is created,
    // rather than this file learning that "Bin it" means delete for one customer.
    const flows = findDeleteFlows([candidate({ accessibleNameRedacted: 'Bin it' })]);
    expect(flows.size).toBe(0);
  });

  it('ignores a control on a route that names no collection', () => {
    const flows = findDeleteFlows([candidate({ routePattern: '/' })]);
    expect(flows.size).toBe(0);
  });
});
