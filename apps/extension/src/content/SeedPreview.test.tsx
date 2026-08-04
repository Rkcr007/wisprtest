import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { IDLE_SEED_VIEW, type SeedNodeView, type SeedView } from '../seed/index.js';
import { SeedPreview } from './SeedPreview.js';

/**
 * The card, against the six things § 6 step 2 requires it to show.
 *
 * "Render the preview: entity, field values, provenance per field, record count, adapter that will
 * run, and whether it can be reverted." Each of those is a test here, because each one is a
 * question the tester would otherwise have to answer by going and looking — and a preview that
 * makes them go and look is a preview they stop reading.
 */

const NODE: SeedNodeView = {
  nodeId: 'order-1',
  entity: 'Order',
  mode: 'create',
  adapter: 'ui',
  adapterReason: 'the API materializer has not been verified in 9 days, so the real form will run',
  revertible: true,
  revertDetail: 'drives the indexed delete flow on /orders/:id',
  fields: [
    {
      field: 'status',
      value: 'Pending',
      source: 'requested',
      explanation: 'you asked for a pending order',
      confidence: 1,
    },
    {
      field: 'amount',
      value: 4200,
      source: 'sampled',
      explanation: 'sampled from 312 observed orders (median 3,980)',
      confidence: 0.82,
    },
  ],
};

function view(overrides: Partial<SeedView> = {}): SeedView {
  return {
    ...IDLE_SEED_VIEW,
    phase: 'previewing',
    utterance: 'I need a pending order for Acme',
    nodes: [NODE],
    ...overrides,
  };
}

function renderCard(overrides: Partial<SeedView> = {}): {
  onApprove: ReturnType<typeof vi.fn>;
  onDismiss: ReturnType<typeof vi.fn>;
  onRevertSession: ReturnType<typeof vi.fn>;
} {
  const handlers = {
    onApprove: vi.fn(),
    onDismiss: vi.fn(),
    onRevertSession: vi.fn(),
  };
  render(<SeedPreview view={view(overrides)} {...handlers} />);
  return handlers;
}

describe('what the card shows before anything is written', () => {
  it('names the entity and every field with its value', () => {
    renderCard();

    expect(screen.getByTestId('wispr-seed-node-order-1').textContent).toContain('Order');
    expect(screen.getByTestId('wispr-seed-field-status').textContent).toContain('Pending');
    expect(screen.getByTestId('wispr-seed-field-amount').textContent).toContain('4200');
  });

  it('shows the provenance explanation for every field, verbatim', () => {
    renderCard();

    // Not "generated". The specificity is the whole point of § 3.
    expect(screen.getByTestId('wispr-seed-field-amount').textContent).toContain(
      'sampled from 312 observed orders (median 3,980)',
    );
    expect(screen.getByTestId('wispr-seed-field-status').textContent).toContain(
      'you asked for a pending order',
    );
  });

  it('states the record count as a count of writes', () => {
    renderCard();
    expect(screen.getByTestId('wispr-seed-count').textContent).toContain('1 record');
  });

  it('does not count a reused reference as something being created', () => {
    renderCard({
      nodes: [
        {
          ...NODE,
          nodeId: 'account-1',
          entity: 'Account',
          mode: 'reuse_existing',
          adapter: null,
          adapterReason: 'the existing Acme Industrial account is used; nothing is created',
          revertible: false,
          revertDetail: 'nothing is created, so there is nothing to remove',
        },
        NODE,
      ],
    });

    expect(screen.getByTestId('wispr-seed-count').textContent).toContain('1 record');
    expect(screen.getByTestId('wispr-seed-node-account-1').textContent).toContain('reuse existing');
  });

  it('names the adapter that will run, and why it and not another', () => {
    renderCard();

    expect(screen.getByTestId('wispr-seed-node-order-1').textContent).toContain(
      'via the real form',
    );
    // § 4: a preview that silently chose the second-best adapter would let a tester draw the wrong
    // conclusion about what the test covered.
    expect(screen.getByTestId('wispr-seed-adapter-order-1').textContent).toContain(
      'the API materializer has not been verified in 9 days',
    );
  });

  it('says whether the record can be removed afterwards', () => {
    renderCard();

    const revert = screen.getByTestId('wispr-seed-revert-order-1');
    expect(revert.getAttribute('data-revertible')).toBe('true');
    expect(revert.textContent).toContain('drives the indexed delete flow on /orders/:id');
  });
});

describe('a record that cannot be removed', () => {
  it('is called out before it is created, not after', () => {
    renderCard({
      nodes: [
        {
          ...NODE,
          revertible: false,
          revertDetail: 'no delete path was indexed for Order — this record will remain',
        },
      ],
    });

    expect(screen.getByTestId('wispr-seed-revert-order-1').getAttribute('data-revertible')).toBe(
      'false',
    );
    // And raised above the per-record line, so it cannot be scrolled past.
    expect(screen.getByTestId('wispr-seed-unrevertable').textContent).toContain(
      'One of these records cannot be removed afterwards.',
    );
  });

  it('says nothing of the sort when every record is revertible', () => {
    renderCard();
    expect(screen.queryByTestId('wispr-seed-unrevertable')).toBeNull();
  });
});

describe('approval', () => {
  it('calls back only when the tester presses the button', () => {
    const { onApprove } = renderCard();

    expect(onApprove).not.toHaveBeenCalled();
    screen.getByTestId('wispr-seed-approve').click();
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('offers discarding as an equal option, not a grey link', () => {
    const { onDismiss } = renderCard();

    const approve = screen.getByTestId('wispr-seed-approve');
    const discard = screen.getByTestId('wispr-seed-discard');
    // Same class, so neither is visually the obvious one — a card whose approve button is the only
    // thing that looks like a button gets approved without being read.
    expect(discard.className).toContain('wispr-hud__button');
    expect(approve.className).toContain('wispr-hud__button');

    discard.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('takes no focus, so a keystroke in flight cannot become a write', () => {
    renderCard();
    // Nothing in the card is autofocused; focus stays wherever the tester left it in the app.
    expect(document.activeElement).toBe(document.body);
    expect(screen.getByTestId('wispr-seed-approve').getAttribute('autofocus')).toBeNull();
  });

  it('offers no approval at all when there is nothing to approve', () => {
    renderCard({
      phase: 'answered',
      nodes: [],
      answer: 'amount cannot be both over 50,000 and under 1,000',
    });

    expect(screen.queryByTestId('wispr-seed-approve')).toBeNull();
    expect(screen.getByTestId('wispr-seed-answer').textContent).toContain(
      'cannot be both over 50,000',
    );
  });
});

describe('after materialization', () => {
  it('shows every rung of the chain, including the ones that failed', () => {
    renderCard({
      phase: 'executed',
      result: {
        planId: '11111111-1111-4111-8111-111111111111',
        outcome: 'created',
        adapterUsed: 'ui',
        attempts: [
          {
            adapter: 'api',
            outcome: 'failed',
            reason: 'the create endpoint returned 422',
            durationMs: 210,
          },
          { adapter: 'ui', outcome: 'succeeded', reason: null, durationMs: 5100 },
        ],
        records: [],
        verifiedAt: '2026-08-04T12:00:05.000Z',
        failureReason: null,
        durationMs: 5400,
      },
    });

    const attempts = screen.getByTestId('wispr-seed-attempts');
    // § 4 forbids silent degradation: the fallback is visible, with its concrete reason.
    expect(attempts.textContent).toContain('API · failed');
    expect(attempts.textContent).toContain('the create endpoint returned 422');
    expect(attempts.textContent).toContain('the real form · succeeded');
  });

  it('names the created records and offers to revert them', () => {
    const { onRevertSession } = renderCard({
      phase: 'executed',
      ledger: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          tenantId: '22222222-2222-4222-8222-222222222222',
          sessionId: '33333333-3333-4333-8333-333333333333',
          planId: '11111111-1111-4111-8111-111111111111',
          nodeId: 'order-1',
          entitySchemaId: '55555555-5555-4555-8555-555555555555',
          entity: 'Order',
          externalRef: 'ORD-4903',
          adapterUsed: 'ui',
          payload: { status: 'Pending' },
          provenance: [],
          inverseOp: { kind: 'ui', flow: 'orders.detail.delete' },
          createdAt: '2026-08-04T12:00:00.000Z',
          revertedAt: null,
        },
      ],
    });

    expect(screen.getByTestId('wispr-seed-created').textContent).toContain('Order ORD-4903');
    screen.getByTestId('wispr-seed-revert').click();
    expect(onRevertSession).toHaveBeenCalledTimes(1);
  });

  it('reports a revert entry by entry, including the one it could not remove', () => {
    renderCard({
      phase: 'executed',
      reverted: [
        {
          ledgerEntryId: '66666666-6666-4666-8666-666666666666',
          entity: 'Order',
          externalRef: 'ORD-4903',
          outcome: 'reverted',
          reason: null,
        },
        {
          ledgerEntryId: '77777777-7777-4777-8777-777777777777',
          entity: 'Order',
          externalRef: 'ORD-4904',
          outcome: 'not_revertible',
          reason: 'no delete path was indexed for Order',
        },
      ],
    });

    const reverted = screen.getByTestId('wispr-seed-reverted');
    expect(reverted.textContent).toContain('ORD-4903 · reverted');
    expect(reverted.textContent).toContain('ORD-4904 · not revertible');
    expect(reverted.textContent).toContain('no delete path was indexed for Order');
  });
});

describe('an idle flow', () => {
  it('renders nothing at all', () => {
    render(
      <SeedPreview
        view={IDLE_SEED_VIEW}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onRevertSession={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('wispr-seed')).toBeNull();
  });
});
