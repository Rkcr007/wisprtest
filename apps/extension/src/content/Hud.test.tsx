import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { INITIAL_UPDATE, type HudUpdate } from '../messaging.js';
import { Hud } from './Hud.js';

/**
 * What the HUD is allowed to claim.
 *
 * Most of these assertions are about the difference between "nothing has happened" and "this is
 * not built yet". The second is where the HUD is in this phase, and a tester reading a zero in
 * "T0 hits" would draw a conclusion about the product that is not true.
 */

const update = (overrides: Partial<HudUpdate> = {}): HudUpdate => ({
  ...INITIAL_UPDATE,
  ...overrides,
});

function renderHud(state: HudUpdate, handlers: { attach?: () => void; detach?: () => void } = {}) {
  return render(
    <Hud
      update={state}
      onAttach={handlers.attach ?? (() => undefined)}
      onDetach={handlers.detach ?? (() => undefined)}
      origin="https://orders.northwind.example"
      version="0.0.0"
    />,
  );
}

describe('the three bands', () => {
  it('starts collapsed, showing only the live band', () => {
    renderHud(update());

    // The HUD is injected into every page the tester visits. It starts as a small panel, not as
    // a three-band console covering the application.
    expect(screen.getByTestId('wispr-hud').dataset.collapsed).toBe('true');
    expect(screen.queryByTestId('wispr-hud-intent')).toBeNull();
    expect(screen.queryByTestId('wispr-hud-telemetry')).toBeNull();
  });

  it('reveals the intent and telemetry bands when expanded', () => {
    renderHud(update());

    fireEvent.click(screen.getByRole('button', { name: 'Expand the WisprTest panel' }));

    expect(screen.getByTestId('wispr-hud-intent')).toBeTruthy();
    expect(screen.getByTestId('wispr-hud-telemetry')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse the WisprTest panel' })).toBeTruthy();
  });

  it('is a region, not a dialog', () => {
    renderHud(update());

    // A dialog implies the tester has to deal with it before returning to the page. This must
    // never be that.
    expect(screen.getByRole('region', { name: 'WisprTest panel' })).toBeTruthy();
  });
});

describe('what it does not claim', () => {
  it('reports measurements nobody has taken as absent, not as zero', () => {
    renderHud(update({ attach: 'attached', token: 'valid' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand the WisprTest panel' }));

    // Tier, resolve latency and step count belong to Phases 8, 10 and 12. A `0` here would be a
    // measurement nobody took, and reads as "the compounding loop is broken" rather than
    // "resolution is not wired up yet".
    const dashes = screen.getAllByLabelText('no data yet');
    expect(dashes.length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText('0')).toBeNull();
  });

  it('shows the microphone as closed rather than as silence', () => {
    renderHud(update({ attach: 'attached' }));

    // Voice arrives in Phase 9. A flat-but-live meter would say the microphone was open and the
    // room was quiet.
    expect(screen.getByRole('meter').getAttribute('aria-valuetext')).toBe('microphone closed');
  });
});

describe('attach state', () => {
  it('names the state on the orb, for assistive technology as well as the eye', () => {
    const { rerender } = renderHud(update());
    expect(screen.getByTestId('wispr-hud-orb').getAttribute('aria-label')).toBe('Detached');

    rerender(
      <Hud
        update={update({ attach: 'attached', token: 'valid' })}
        onAttach={() => undefined}
        onDetach={() => undefined}
        origin="https://orders.northwind.example"
        version="0.0.0"
      />,
    );
    expect(screen.getByTestId('wispr-hud-orb').getAttribute('aria-label')).toBe('Attached');
  });

  it('asks the worker to attach when the tester presses Attach', () => {
    const attach = vi.fn();
    renderHud(update(), { attach });

    fireEvent.click(screen.getByTestId('wispr-hud-attach'));

    expect(attach).toHaveBeenCalledOnce();
  });

  it('offers Detach once attached', () => {
    const detach = vi.fn();
    renderHud(update({ attach: 'attached', token: 'valid' }), { detach });

    fireEvent.click(screen.getByTestId('wispr-hud-attach'));

    expect(detach).toHaveBeenCalledOnce();
  });

  it('disables the control while an attach is in flight', () => {
    renderHud(update({ attach: 'attaching', token: 'refreshing' }));

    // A tester pressing the button twice should not mint two tokens.
    expect(screen.getByTestId('wispr-hud-attach')).toHaveProperty('disabled', true);
  });
});

describe('failure', () => {
  it('says what the tester should do next, not what the error was', () => {
    renderHud(update({ attach: 'failed', failure: 'unauthenticated', token: 'failed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand the WisprTest panel' }));

    const toast = screen.getByTestId('wispr-toast');
    expect(toast.textContent).toContain('Sign in to the WisprTest console');
    // Drift tone: it interrupts the announcement, and it does not block the tester.
    expect(toast.getAttribute('role')).toBe('alert');
  });

  it('does not blame the tester for the control plane being down', () => {
    renderHud(update({ attach: 'failed', failure: 'unreachable', token: 'failed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand the WisprTest panel' }));

    expect(screen.getByTestId('wispr-toast').textContent).toContain('not something you can fix');
  });
});

describe('an application nobody has indexed', () => {
  it('says so plainly instead of showing an error', () => {
    renderHud(update({ attach: 'attached', token: 'valid', applicationId: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand the WisprTest panel' }));

    // Browsing an unindexed application is a normal thing for a tester to do.
    expect(screen.queryByTestId('wispr-toast')).toBeNull();
    expect(screen.getByText(/No application is registered/)).toBeTruthy();
  });
});
