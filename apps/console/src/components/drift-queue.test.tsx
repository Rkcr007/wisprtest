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

function hrefOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  throw new Error('expected a fetch URL');
}

function clickNamed(name: string): void {
  const [button] = screen.getAllByRole('button', { name });
  if (button === undefined) throw new Error(`no ${name} button`);
  fireEvent.click(button);
}

function isStringBodyInit(init: unknown): init is { body: string } {
  return (
    typeof init === 'object' && init !== null && 'body' in init && typeof init.body === 'string'
  );
}

function postedJson(fetchMock: ReturnType<typeof vi.fn>, path: string): unknown {
  const posted = fetchMock.mock.calls.find((call) => hrefOf(call[0]) === path);
  if (posted === undefined) throw new Error(`no request to ${path}`);
  const init: unknown = posted[1];
  if (!isStringBodyInit(init)) throw new Error('expected a JSON string body');
  return JSON.parse(init.body);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(DRIFT_LIST)));
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
    const path = `/api/drift/${DIFFED_REPORT.id}/approve`;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (hrefOf(input) === path) return Promise.resolve(jsonResponse(APPROVED));
      return Promise.resolve(jsonResponse(DRIFT_LIST));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderQueue();

    clickNamed('Approve');

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
    });

    expect(postedJson(fetchMock, path)).toEqual({ decision: 'approve' });
  });

  it('puts the row back when the gateway refuses the approval', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (hrefOf(input) === `/api/drift/${DIFFED_REPORT.id}/approve`) {
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

    clickNamed('Approve');

    await waitFor(() => {
      expect(
        screen.getByText(
          'this report has not been reconciled yet, so there is nothing to activate',
        ),
      ).toBeTruthy();
    });
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(2);
  });

  it('does not call the BFF when Reject is confirmed with no reason', () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(DRIFT_LIST));
    vi.stubGlobal('fetch', fetchMock);
    renderQueue();

    clickNamed('Reject');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reject' }));

    expect(screen.getByText(/names why/)).toBeTruthy();
    expect(fetchMock.mock.calls.some((call) => hrefOf(call[0]).includes('/api/drift/'))).toBe(
      false,
    );
  });

  it('posts a rejection with the reason and removes the row', async () => {
    const path = `/api/drift/${DIFFED_REPORT.id}/approve`;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (hrefOf(input) === path) return Promise.resolve(jsonResponse(REJECTED));
      return Promise.resolve(jsonResponse(DRIFT_LIST));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderQueue();

    clickNamed('Reject');
    fireEvent.change(screen.getByLabelText(/^Reason$/), {
      target: { value: 'the create form was mid-deploy' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reject' }));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
    });

    expect(postedJson(fetchMock, path)).toEqual({
      decision: 'reject',
      reason: 'the create form was mid-deploy',
    });
  });
});
