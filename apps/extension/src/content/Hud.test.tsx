import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { INITIAL_UPDATE, type HudUpdate } from '../messaging.js';
import { Hud, type FalseExecutionView } from './Hud.js';

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

describe('typed commands', () => {
  it('is not offered when there is no command handler', () => {
    renderHud(update({ attach: 'attached' }));

    expect(screen.queryByTestId('wispr-hud-type')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand the WisprTest panel' }));
    expect(screen.queryByTestId('wispr-hud-command')).toBeNull();
  });

  it('submits the draft as a finished transcript and clears the field', () => {
    const onCommand = vi.fn();
    render(
      <Hud
        update={update({ attach: 'attached' })}
        onAttach={() => undefined}
        onDetach={() => undefined}
        onCommand={onCommand}
        origin="https://orders.northwind.example"
        version="0.0.0"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Type a command' }));
    fireEvent.change(screen.getByTestId('wispr-hud-command'), {
      target: { value: 'open orders' },
    });
    fireEvent.submit(screen.getByTestId('wispr-hud-command-form'));

    expect(onCommand).toHaveBeenCalledExactlyOnceWith('open orders');
    expect(screen.getByTestId('wispr-hud-command')).toHaveProperty('value', '');
  });

  it('does not submit whitespace', () => {
    const onCommand = vi.fn();
    render(
      <Hud
        update={update({ attach: 'attached' })}
        onAttach={() => undefined}
        onDetach={() => undefined}
        onCommand={onCommand}
        origin="https://orders.northwind.example"
        version="0.0.0"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand the WisprTest panel' }));
    fireEvent.change(screen.getByTestId('wispr-hud-command'), { target: { value: '   ' } });
    fireEvent.submit(screen.getByTestId('wispr-hud-command-form'));

    expect(onCommand).not.toHaveBeenCalled();
  });
});

describe('the drift notice', () => {
  /**
   * Phase 17's non-blocking notice. Its job is to explain why the panel is suddenly asking for
   * confirmations, without becoming the thing the tester has to deal with first.
   */

  function renderDrifted(props: { onDriftDismiss?: () => void } = {}) {
    return render(
      <Hud
        update={update({ attach: 'attached' })}
        drifted
        {...props}
        onAttach={() => undefined}
        onDetach={() => undefined}
        origin="https://orders.northwind.example"
        version="0.0.0"
      />,
    );
  }

  it('renders nothing while the screen still matches memory', () => {
    renderHud(update({ attach: 'attached' }));

    expect(screen.queryByTestId('wispr-hud-drift')).toBeNull();
  });

  it('shows the notice while the panel is collapsed', () => {
    // Outside the collapse deliberately: the notice explains a change in how the panel behaves,
    // and a tester who could not see it would experience degraded mode as a refusal to act.
    renderDrifted();

    expect(screen.getByTestId('wispr-hud').dataset.collapsed).toBe('true');
    expect(screen.getByTestId('wispr-hud-drift')).toBeTruthy();
  });

  it('says what changed and what still works', () => {
    renderDrifted();

    const notice = screen.getByTestId('wispr-hud-drift');
    expect(notice.textContent).toContain('changed since it was indexed');
    expect(notice.textContent).toContain('Everything else works as usual');
  });

  it('interrupts the announcement without taking focus or blocking input', () => {
    // `alert` is right for "the application changed under you" — it interrupts a screen reader
    // mid-sentence. It must interrupt the announcement and nothing else.
    const { container } = renderDrifted();

    expect(screen.getByTestId('wispr-toast').getAttribute('role')).toBe('alert');
    // A region, never a dialog: nothing traps focus, and the panel is still just a panel.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('names the page but never anything on it', () => {
    // CLAUDE.md § "PII rule": the notice describes structure. No route, no element, no text.
    renderDrifted();

    const notice = screen.getByTestId('wispr-hud-drift');
    expect(notice.textContent).not.toContain('/orders');
  });

  it('lets the tester hide it', () => {
    const onDriftDismiss = vi.fn();
    renderDrifted({ onDriftDismiss });

    fireEvent.click(screen.getByText('Hide'));

    expect(onDriftDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('reporting a false execution', () => {
  /**
   * The tester's own verdict on the step that just ran — the only producer of the metric
   * CLAUDE.md gates releases on. Nothing in the runtime can detect it: the resolver was
   * confident and the dispatch succeeded, so the measurement begins with a person.
   */

  const reportable: FalseExecutionView = {
    stepOrdinal: 4,
    utterance: 'approve the acme order',
    status: 'idle',
    detail: null,
  };

  function renderReportable(
    props: {
      falseExecution?: FalseExecutionView | null;
      onReportFalseExecution?: (reason: string) => void;
    } = {},
  ) {
    return render(
      <Hud
        update={update({ attach: 'attached' })}
        falseExecution={props.falseExecution ?? reportable}
        {...(props.onReportFalseExecution === undefined
          ? {}
          : { onReportFalseExecution: props.onReportFalseExecution })}
        onAttach={() => undefined}
        onDetach={() => undefined}
        origin="https://orders.northwind.example"
        version="0.0.0"
      />,
    );
  }

  it('offers nothing until something has executed', () => {
    renderHud(update({ attach: 'attached' }));

    expect(screen.queryByTestId('wispr-hud-false-execution')).toBeNull();
  });

  it('is reachable while the panel is collapsed', () => {
    // The HUD starts collapsed, and a tester who has just watched a wrong click will not first
    // expand a panel. Same reasoning as the drift notice.
    renderReportable();

    expect(screen.getByTestId('wispr-hud').dataset.collapsed).toBe('true');
    expect(screen.getByTestId('wispr-hud-false-execution-open')).toBeTruthy();
  });

  it('asks which of the three before it files anything', () => {
    const onReport = vi.fn();
    renderReportable({ onReportFalseExecution: onReport });

    // Closed, the prompt is one small button — a row of reasons under every action is noise a
    // tester learns to look past.
    expect(screen.queryByTestId('wispr-hud-false-execution-wrong_element')).toBeNull();

    fireEvent.click(screen.getByTestId('wispr-hud-false-execution-open'));

    expect(screen.getByTestId('wispr-hud-false-execution-wrong_element')).toBeTruthy();
    expect(screen.getByTestId('wispr-hud-false-execution-wrong_action')).toBeTruthy();
    expect(screen.getByTestId('wispr-hud-false-execution-unintended_state_change')).toBeTruthy();
    expect(onReport).not.toHaveBeenCalled();
  });

  it('reports the reason the tester picked, not a default', () => {
    const onReport = vi.fn();
    renderReportable({ onReportFalseExecution: onReport });

    fireEvent.click(screen.getByTestId('wispr-hud-false-execution-open'));
    fireEvent.click(screen.getByTestId('wispr-hud-false-execution-wrong_action'));

    // The three are fixed in different places; a counter that cannot attribute a breach tells
    // you the budget is blown without telling you which subsystem to open.
    expect(onReport).toHaveBeenCalledWith('wrong_action');
  });

  it('says it landed, and stops offering the reasons', () => {
    renderReportable({ falseExecution: { ...reportable, status: 'filed' } });

    expect(screen.getByRole('status').textContent).toContain('Reported');
    expect(screen.queryByTestId('wispr-hud-false-execution-open')).toBeNull();
  });

  it('says so when it did not land, rather than implying it did', () => {
    // The failure a tester can act on: the step had not reached the gateway yet.
    renderReportable({
      falseExecution: {
        ...reportable,
        status: 'failed',
        detail: 'Not recorded — the step has not reached the gateway yet.',
      },
    });

    fireEvent.click(screen.getByTestId('wispr-hud-false-execution-open'));

    expect(screen.getByText(/has not reached the gateway/)).toBeTruthy();
    expect(screen.getByTestId('wispr-hud-false-execution-wrong_element')).toBeTruthy();
  });

  it('does not let a stale prompt file against a newer step', () => {
    const onReport = vi.fn();
    const { rerender } = renderReportable({ onReportFalseExecution: onReport });

    fireEvent.click(screen.getByTestId('wispr-hud-false-execution-open'));
    expect(screen.getByTestId('wispr-hud-false-execution-wrong_element')).toBeTruthy();

    // The tester moved on and something else executed. The open prompt belonged to the previous
    // ordinal, and leaving it open invites a report against the wrong step.
    rerender(
      <Hud
        update={update({ attach: 'attached' })}
        falseExecution={{ ...reportable, stepOrdinal: 5 }}
        onReportFalseExecution={onReport}
        onAttach={() => undefined}
        onDetach={() => undefined}
        origin="https://orders.northwind.example"
        version="0.0.0"
      />,
    );

    expect(screen.queryByTestId('wispr-hud-false-execution-wrong_element')).toBeNull();
    expect(screen.getByTestId('wispr-hud-false-execution-open')).toBeTruthy();
  });
});
