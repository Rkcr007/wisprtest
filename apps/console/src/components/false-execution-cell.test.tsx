import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OPEN_FALSE_EXECUTION, SESSION_ID, WITHDRAWN_FALSE_EXECUTION } from '../drift/fixtures';
import { FalseExecutionCell } from './false-execution-cell';

/**
 * The report cell, wired.
 *
 * `../sessions/false-execution` already proves the parse rules. What this adds is the wiring
 * that decides whether the release gate's numerator is honest: what actually reaches the BFF,
 * that an unexplained withdrawal never leaves the browser, and that a gateway refusal is
 * repeated to the tester rather than swallowed.
 */

const FILE_PATH = `/api/sessions/${SESSION_ID}/false-executions`;
const WITHDRAW_PATH = `/api/sessions/${SESSION_ID}/false-executions/4/withdraw`;

/**
 * A fetch-shaped mock.
 *
 * Typed rather than left as `ReturnType<typeof vi.fn>`: an untyped `vi.fn()` infers a `undefined`
 * return, so handing `mockImplementation` a promise-returning function reads as a misused
 * promise even though that is exactly what `fetch` does.
 */
type FetchMock = ReturnType<typeof vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>>;

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

function isStringBodyInit(init: unknown): init is { body: string } {
  return (
    typeof init === 'object' && init !== null && 'body' in init && typeof init.body === 'string'
  );
}

/**
 * The POST to `path`, if there was one.
 *
 * Matched on the method as well as the URL: the list query GETs the very same path the file
 * POST uses, so a URL-only match would find the read and report no body.
 */
function postsTo(fetchMock: FetchMock, path: string): readonly unknown[][] {
  return fetchMock.mock.calls.filter((call) => {
    if (hrefOf(call[0]) !== path) return false;
    const init: unknown = call[1];
    return typeof init === 'object' && init !== null && 'method' in init && init.method === 'POST';
  });
}

function postedJson(fetchMock: FetchMock, path: string): unknown {
  const [posted] = postsTo(fetchMock, path);
  if (posted === undefined) throw new Error(`no POST to ${path}`);
  const init: unknown = posted[1];
  if (!isStringBodyInit(init)) throw new Error('expected a JSON string body');
  return JSON.parse(init.body);
}

function clickNamed(name: string): void {
  const [button] = screen.getAllByRole('button', { name });
  if (button === undefined) throw new Error(`no ${name} button`);
  fireEvent.click(button);
}

function renderCell(initial: readonly (typeof OPEN_FALSE_EXECUTION)[] = []): void {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <FalseExecutionCell sessionId={SESSION_ID} stepOrdinal={4} initial={initial} />
    </QueryClientProvider>,
  );
}

function fetchMock(): FetchMock {
  return globalThis.fetch as unknown as FetchMock;
}

beforeEach(() => {
  // `mockImplementation`, not `mockResolvedValue`: a Response body can be read exactly once, and
  // a single shared instance would be drained by the list query before any POST could parse it.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(OPEN_FALSE_EXECUTION))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FalseExecutionCell', () => {
  it('files a report with the chosen reason and a trimmed note', async () => {
    renderCell();
    clickNamed('Report');

    fireEvent.change(screen.getByLabelText('What went wrong?'), {
      target: { value: 'wrong_action' },
    });
    fireEvent.change(screen.getByLabelText('Note (optional)'), {
      target: { value: '  it archived instead  ' },
    });
    clickNamed('File report');

    await waitFor(() => {
      expect(postedJson(fetchMock(), FILE_PATH)).toEqual({
        stepOrdinal: 4,
        reason: 'wrong_action',
        expectedElementId: null,
        note: 'it archived instead',
      });
    });
  });

  it('never posts a report with no reason chosen', () => {
    renderCell();
    clickNamed('Report');
    clickNamed('File report');

    expect(postsTo(fetchMock(), FILE_PATH)).toHaveLength(0);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('repeats the gateway refusal rather than swallowing it', async () => {
    fetchMock().mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          {
            code: 'validation_failed',
            message: 'session has no step at that ordinal',
            issues: [{ path: 'stepOrdinal', message: 'session has no step at that ordinal' }],
          },
          400,
        ),
      ),
    );

    renderCell();
    clickNamed('Report');
    fireEvent.change(screen.getByLabelText('What went wrong?'), {
      target: { value: 'wrong_element' },
    });
    clickNamed('File report');

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('no step at that ordinal');
    });
  });

  it('shows a standing report and withdraws it with a reason', async () => {
    renderCell([OPEN_FALSE_EXECUTION]);

    expect(screen.getByText('Wrong element')).toBeTruthy();
    clickNamed('Withdraw');

    fireEvent.change(screen.getByLabelText('Why withdraw?'), {
      target: { value: 'filed against the wrong step' },
    });
    clickNamed('Confirm withdrawal');

    await waitFor(() => {
      expect(postedJson(fetchMock(), WITHDRAW_PATH)).toEqual({
        reason: 'filed against the wrong step',
      });
    });
  });

  it('never posts a withdrawal with no reason — it moves a release gate', () => {
    renderCell([OPEN_FALSE_EXECUTION]);
    clickNamed('Withdraw');
    clickNamed('Confirm withdrawal');

    expect(postsTo(fetchMock(), WITHDRAW_PATH)).toHaveLength(0);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('renders a withdrawn report as withdrawn, and offers no second withdrawal', () => {
    renderCell([WITHDRAWN_FALSE_EXECUTION]);

    expect(screen.getByText(/Withdrawn/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
    // Nor a Report button: the row already carries its history, and re-filing is a decision
    // made against a fresh page rather than by clicking through a retraction.
    expect(screen.queryByRole('button', { name: 'Report' })).toBeNull();
  });

  it('does not hide the control from anyone — the gateway decides who may file', () => {
    renderCell();

    // No role is inspected here. A viewer sees Report, clicks it, and is told no by the
    // service that actually decides, as on the drift queue.
    expect(screen.getByRole('button', { name: 'Report' })).toBeTruthy();
  });
});
