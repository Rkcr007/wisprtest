import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APPLICATION_ID, APPROVED, DIFFED_REPORT, DRIFT_LIST, REJECTED } from '../drift/fixtures';
import { DriftQueue } from './drift-queue';

/**
 * Drift, rendered.
 *
 * `decision.ts` already proves the parse rules. What this adds is the wiring: Approve leaves
 * immediately, a refused Approve puts the row back, and a rejection without a reason never
 * reaches the BFF.
 */

function renderQueue(): ReactElement {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const tree = (
    <QueryClientProvider client={client}>
      <DriftQueue applicationId={APPLICATION_ID} initial={DRIFT_LIST} />
    </QueryClientProvider>
  );
  render(tree);
  return tree;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(jsonResponse(DRIFT_LIST)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DriftQueue', () => {
  it('renders the pending reports from the server-fetched list', () => {
    renderQueue();

    expect(screen.getByRole('heading', { name: 'Drift' })).toBeTruthy();
    expect(screen.getAllByText('/orders/:id').length).toBeGreaterThan(0);
    expect(screen.getAllByText('/orders/4903').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(2);
  });

  it('posts an approval and removes the row immediately', async () => {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (String(url) === `/api/drift/${DIFFED_REPORT.id}/approve`) {
        return Promise.resolve(jsonResponse(APPROVED));
      }
      return Promise.resolve(jsonResponse(DRIFT_LIST));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderQueue();

    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]!);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
    });

    const posted = fetchMock.mock.calls.find(
      (call) => String(call[0]) === `/api/drift/${DIFFED_REPORT.id}/approve`,
    );
    expect(posted).toBeDefined();
    expect(JSON.parse(String(posted?.[1]?.body))).toEqual({ decision: 'approve' });
  });

  it('puts the row back when the gateway refuses the approval', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (String(url) === `/api/drift/${DIFFED_REPORT.id}/approve`) {
          return Promise.resolve(
            jsonResponse(
              {
                code: 'validation_failed',
                message: 'this report has not been reconciled yet, so there is nothing to activate',
                issues: [{ path: 'id', message: 'the report is open' }],
              },
              400,
            ),
          );
        }
        return Promise.resolve(jsonResponse(DRIFT_LIST));
      }),
    );
    renderQueue();

    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]!);

    await waitFor(() => {
      expect(
        screen.getByText('this report has not been reconciled yet, so there is nothing to activate'),
      ).toBeTruthy();
    });
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(2);
  });

  it('does not call the BFF when Reject is confirmed with no reason', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(DRIFT_LIST));
    vi.stubGlobal('fetch', fetchMock);
    renderQueue();

    fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reject' }));

    expect(screen.getByText(/names why/)).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/api/drift/')),
    ).toBe(false);
  });

  it('posts a rejection with the reason and removes the row', async () => {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (String(url) === `/api/drift/${DIFFED_REPORT.id}/approve`) {
        return Promise.resolve(jsonResponse(REJECTED));
      }
      return Promise.resolve(jsonResponse(DRIFT_LIST));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderQueue();

    fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[0]!);
    fireEvent.change(screen.getByLabelText(/^Reason$/), {
      target: { value: 'the create form was mid-deploy' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reject' }));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
    });

    const posted = fetchMock.mock.calls.find(
      (call) => String(call[0]) === `/api/drift/${DIFFED_REPORT.id}/approve`,
    );
    expect(JSON.parse(String(posted?.[1]?.body))).toEqual({
      decision: 'reject',
      reason: 'the create form was mid-deploy',
    });
  });
});
