import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import {
  APPLICATION_ID,
  EVIDENCE_KEY,
  OPEN_FALSE_EXECUTION,
  SESSION_STEP,
  SESSION_TIMELINE,
  WITHDRAWN_FALSE_EXECUTION,
} from '../drift/fixtures';
import { SessionTimelineView } from './session-timeline';

/**
 * Session detail, rendered.
 *
 * The property that matters: a signed key becomes a link to the gateway's URL, and an unsigned
 * key does not become a guessed one.
 *
 * The *False execution* column is a client island, so these renders need a QueryClient the way
 * the real tree gets one from `Providers` in the root layout.
 */

function renderTimeline(element: ReactElement): void {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

describe('SessionTimelineView', () => {
  it('renders the closed session, the step, and the signed screenshot', () => {
    renderTimeline(<SessionTimelineView timeline={SESSION_TIMELINE} />);

    expect(screen.getByRole('heading', { name: 'Session' })).toBeTruthy();
    expect(screen.getByText('Closed')).toBeTruthy();
    expect(screen.getByText('show me only the pending ones')).toBeTruthy();
    expect(screen.getByText('T0')).toBeTruthy();
    expect(screen.getByText('R')).toBeTruthy();
    expect(screen.getByText('executed')).toBeTruthy();

    const link = screen.getByRole('link', { name: 'Screenshot' });
    expect(link.getAttribute('href')).toBe(
      'https://evidence.wisprtest.example/tenants/3f2504e0/step-4.png?sig=abc',
    );
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('does not invent a link when the gateway did not sign the key', () => {
    renderTimeline(
      <SessionTimelineView
        timeline={{
          ...SESSION_TIMELINE,
          evidence: [],
          steps: [SESSION_STEP],
        }}
      />,
    );

    expect(screen.queryByRole('link', { name: 'Screenshot' })).toBeNull();
    expect(screen.getByText(/not signed/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(EVIDENCE_KEY);
  });

  it('renders an open session with no steps as empty, not as a fabricated timeline', () => {
    renderTimeline(
      <SessionTimelineView
        timeline={{
          session: {
            ...SESSION_TIMELINE.session,
            applicationId: APPLICATION_ID,
            endedAt: null,
          },
          steps: [],
          evidence: [],
        }}
      />,
    );

    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByText('No steps recorded yet.')).toBeTruthy();
  });

  it('offers a step with no report the way to file one', () => {
    renderTimeline(<SessionTimelineView timeline={SESSION_TIMELINE} />);

    expect(screen.getByRole('columnheader', { name: 'False execution' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Report' })).toBeTruthy();
  });

  it('shows the standing report instead of offering to file another', () => {
    renderTimeline(
      <SessionTimelineView timeline={SESSION_TIMELINE} reports={[OPEN_FALSE_EXECUTION]} />,
    );

    expect(screen.getByText('Wrong element')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Report' })).toBeNull();
  });

  it('keeps a withdrawn report visible rather than pretending it never happened', () => {
    renderTimeline(
      <SessionTimelineView timeline={SESSION_TIMELINE} reports={[WITHDRAWN_FALSE_EXECUTION]} />,
    );

    expect(screen.getByText(/Withdrawn/)).toBeTruthy();
  });

  it('renders the evidence column unchanged when reports fail to load', () => {
    // The page passes an empty list rather than erroring: reports annotate the evidence, they
    // are not the evidence, so losing them must not cost the timeline.
    renderTimeline(<SessionTimelineView timeline={SESSION_TIMELINE} reports={[]} />);

    expect(screen.getByRole('link', { name: 'Screenshot' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Report' })).toBeTruthy();
  });
});
