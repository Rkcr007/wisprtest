import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { APPLICATION_ID, EVIDENCE_KEY, SESSION_STEP, SESSION_TIMELINE } from '../drift/fixtures';
import { SessionTimelineView } from './session-timeline';

/**
 * Session detail, rendered.
 *
 * The property that matters: a signed key becomes a link to the gateway's URL, and an unsigned
 * key does not become a guessed one.
 */

describe('SessionTimelineView', () => {
  it('renders the closed session, the step, and the signed screenshot', () => {
    render(<SessionTimelineView timeline={SESSION_TIMELINE} />);

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
    render(
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
    expect(document.body.textContent ?? '').not.toContain(EVIDENCE_KEY);
  });

  it('renders an open session with no steps as empty, not as a fabricated timeline', () => {
    render(
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
});
