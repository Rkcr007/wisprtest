import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { primitivesCss } from './primitives.css.js';
import { Cell, Chip, GhostCursor, Reticle, Toast, VadBars } from './primitives.js';

/**
 * What these tests are for.
 *
 * Not "does it render" — every one of these asserts a piece of the product's vocabulary that a
 * tester relies on: that a colour means what it means, that a missing measurement is stated
 * rather than reported as zero, and that anything which changes on its own reaches a screen
 * reader.
 */

describe('Reticle', () => {
  it('renders nothing when there is no target', () => {
    render(<Reticle rect={null} />);

    expect(screen.queryByTestId('wispr-reticle')).toBeNull();
  });

  it('draws four corner brackets at the target', () => {
    render(<Reticle rect={{ x: 120.4, y: 240.6, width: 88, height: 32 }} />);
    const reticle = screen.getByTestId('wispr-reticle');

    // Brackets, not a box: the tester has to be able to read the control being aimed at.
    expect(reticle.querySelectorAll('.wispr-reticle__corner')).toHaveLength(4);
    expect(reticle.style.transform).toBe('translate3d(120px, 241px, 0)');
    expect(reticle.style.width).toBe('88px');
  });

  it('is decoration unless it is given something to announce', () => {
    const { rerender } = render(<Reticle rect={{ x: 0, y: 0, width: 10, height: 10 }} />);
    expect(screen.getByTestId('wispr-reticle').getAttribute('aria-hidden')).toBe('true');

    rerender(<Reticle rect={{ x: 0, y: 0, width: 10, height: 10 }} label="Approve order" />);
    expect(screen.getByRole('img', { name: 'Approve order' })).toBeTruthy();
  });

  it('shows executed in the commit colour and everything else in signal', () => {
    // The class is the claim: mint means it ran. A staged action that rendered as executed would
    // tell a tester something happened when nothing did.
    const { rerender } = render(
      <Reticle rect={{ x: 0, y: 0, width: 10, height: 10 }} state="staged" />,
    );
    expect(screen.getByTestId('wispr-reticle').className).toContain('wispr-reticle--staged');

    rerender(<Reticle rect={{ x: 0, y: 0, width: 10, height: 10 }} state="executed" />);
    expect(screen.getByTestId('wispr-reticle').className).toContain('wispr-reticle--executed');
  });
});

describe('GhostCursor', () => {
  it('is hidden from assistive technology', () => {
    render(<GhostCursor x={10} y={20} />);

    // It duplicates what the reticle already conveys, for peripheral vision. Announcing it would
    // mean a screen reader user hears the same thing twice.
    expect(screen.getByTestId('wispr-ghost-cursor').getAttribute('aria-hidden')).toBe('true');
  });

  it('renders nothing when not visible', () => {
    render(<GhostCursor x={10} y={20} visible={false} />);

    expect(screen.queryByTestId('wispr-ghost-cursor')).toBeNull();
  });
});

describe('VadBars', () => {
  it('distinguishes a closed microphone from a quiet room', () => {
    // These are completely different facts and must never look — or sound — the same.
    const { rerender } = render(<VadBars level={null} />);
    const idle = screen.getByRole('meter');
    expect(idle.className).toContain('wispr-vad--idle');
    expect(idle.getAttribute('aria-valuetext')).toBe('microphone closed');

    rerender(<VadBars level={0} />);
    const quiet = screen.getByRole('meter');
    expect(quiet.className).not.toContain('wispr-vad--idle');
    expect(quiet.getAttribute('aria-valuetext')).toBe('0%');
  });

  it('reports the level as a meter', () => {
    render(<VadBars level={0.42} />);
    const meter = screen.getByRole('meter', { name: 'Voice activity' });

    expect(meter.getAttribute('aria-valuenow')).toBe('42');
    expect(meter.getAttribute('aria-valuemax')).toBe('100');
  });

  it('clamps a level outside the range instead of drawing outside the strip', () => {
    render(<VadBars level={4} />);

    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('100');
  });
});

describe('Chip', () => {
  it('carries its tone as data, so the meaning is assertable and not just visual', () => {
    render(<Chip tone="commit">executed</Chip>);

    expect(screen.getByText('executed').dataset.tone).toBe('commit');
  });

  it('announces politely when it reports something that changes on its own', () => {
    render(
      <Chip tone="memory" live>
        attached
      </Chip>,
    );

    expect(screen.getByText('attached').getAttribute('aria-live')).toBe('polite');
  });
});

describe('Cell', () => {
  it('states that a value does not exist yet, rather than reporting zero', () => {
    // This is the whole reason `value` is nullable. A `0` here would be a measurement nobody
    // took, and "no resolutions have happened" reads very differently from "resolution is not
    // wired up yet".
    render(<Cell label="T0 hits" value={null} />);

    const dash = screen.getByLabelText('no data yet');
    expect(dash.textContent).toBe('—');
  });

  it('renders a real value with its unit', () => {
    render(<Cell label="Latency" value={12} unit="ms" tone="commit" />);

    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('ms')).toBeTruthy();
  });

  it('does not put a unit on a missing value', () => {
    render(<Cell label="Latency" value={null} unit="ms" />);

    expect(screen.queryByText('ms')).toBeNull();
  });
});

describe('Toast', () => {
  it('is a polite status by default', () => {
    render(<Toast title="Attached" detail="orders.northwind.example" />);
    const toast = screen.getByTestId('wispr-toast');

    expect(toast.getAttribute('role')).toBe('status');
    expect(toast.getAttribute('aria-live')).toBe('polite');
  });

  it('interrupts for drift, because the tester is acting on stale knowledge', () => {
    render(<Toast tone="drift" title="Screen changed" />);
    const toast = screen.getByTestId('wispr-toast');

    // Interrupts the announcement, not the tester: drift never blocks work.
    expect(toast.getAttribute('role')).toBe('alert');
    expect(toast.getAttribute('aria-live')).toBe('assertive');
  });

  it('offers a named dismiss control only when it can be dismissed', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Toast title="Attached" />);
    expect(screen.queryByRole('button')).toBeNull();

    rerender(<Toast title="Attached" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe('primitivesCss', () => {
  it('expresses every colour and duration as a token', () => {
    // A hard-coded colour here is a colour that means nothing, and a hard-coded duration is one
    // that prefers-reduced-motion cannot switch off.
    const hardCodedColour = /:\s*#[0-9a-f]{3,8}\b/i;
    const hardCodedDuration = /transition:[^;]*\b\d+m?s\b/;

    expect(primitivesCss).not.toMatch(hardCodedColour);
    expect(primitivesCss).not.toMatch(hardCodedDuration);
  });

  it('gives everything focusable one visible focus treatment', () => {
    expect(primitivesCss).toContain(':focus-visible');
    expect(primitivesCss).toContain('var(--wispr-focus-ring)');
  });
});
