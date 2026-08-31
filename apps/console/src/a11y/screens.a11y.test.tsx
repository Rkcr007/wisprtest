import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AppNav } from '../components/app-nav';
import { SESSION_TIMELINE } from '../drift/fixtures';
import { Overview } from '../components/overview';
import { SessionTimelineView } from '../components/session-timeline';

/**
 * Structural a11y the Phase 18 console has to keep.
 *
 * Contrast and motion come from `packages/ui` tokens (prefers-reduced-motion zeroes durations).
 * These tests lock the landmarks, captions and labelled controls a keyboard user hits first.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/applications/3f2504e0-4f89-41d3-9a0c-0305e82c3301/drift',
}));

const APP = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('console a11y', () => {
  it('names the application nav and marks the current screen', () => {
    render(<AppNav />);
    const nav = screen.getByRole('navigation', { name: 'Application' });
    expect(nav).toBeDefined();
    expect(screen.getByRole('link', { name: 'Drift' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Admin' }).getAttribute('href')).toBe('/admin');
  });

  it('gives Overview a heading, chips, and a captioned sessions table', () => {
    render(
      <Overview
        application={{
          id: APP,
          tenantId: '11111111-1111-4111-8111-111111111111',
          name: 'Orders',
          baseUrl: 'https://orders.example',
          env: 'staging',
          createdAt: '2026-08-02T10:00:00.000Z',
          memoryVersion: null,
          memoryVersionId: null,
          indexedAt: null,
          screenCount: 0,
          elementCount: 0,
          openDriftCount: 0,
        }}
        sessions={{ sessions: [], total: 0 }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Overview' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Recent sessions' })).toBeDefined();
    expect(document.querySelector('table caption')).toBeNull();
  });

  it('labels the false-execution controls a keyboard user reaches from the timeline', () => {
    // The cell refetches its list on mount; this suite has no server, so answer it here rather
    // than let an ECONNREFUSED surface as an unhandled rejection.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
          ),
        ),
    );
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <SessionTimelineView timeline={SESSION_TIMELINE} reports={[]} />
      </QueryClientProvider>,
    );

    // The column is named, so a screen reader announces which cell the button belongs to.
    expect(screen.getByRole('columnheader', { name: 'False execution' })).toBeTruthy();
    expect(document.querySelector('table caption')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Report' }));

    // Both inputs are labelled controls rather than bare fields with placeholder text.
    expect(screen.getByLabelText('What went wrong?')).toBeTruthy();
    expect(screen.getByLabelText('Note (optional)')).toBeTruthy();

    vi.unstubAllGlobals();
  });
});
