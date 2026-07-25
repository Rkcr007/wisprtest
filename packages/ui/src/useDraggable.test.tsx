import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clamp, magnetize, toEdge, useDraggable, type DraggableOptions } from './useDraggable.js';

/**
 * The geometry is tested directly and the hook is tested through a component.
 *
 * Splitting them is deliberate: `magnetize` and `clamp` are where the behaviour a tester notices
 * actually lives — which edge it snaps to, whether it can be dragged off-screen — and testing
 * them through pointer events would mean asserting on a transform string to learn whether a
 * corner release picked the right edge.
 */

const SIZE = { width: 320, height: 180 };
const BOUNDS = { width: 1280, height: 800 };
const MARGIN = 12;

describe('clamp', () => {
  it('keeps the panel fully inside the viewport', () => {
    expect(clamp({ x: -500, y: -500 }, SIZE, BOUNDS, MARGIN)).toEqual({ x: 12, y: 12 });
    expect(clamp({ x: 5000, y: 5000 }, SIZE, BOUNDS, MARGIN)).toEqual({ x: 948, y: 608 });
  });

  it('survives a viewport smaller than the panel', () => {
    // A tester with a narrow window must still be able to see and grab the HUD, even if it
    // cannot fit entirely. Pinned to the top-left beats clamped to a negative coordinate.
    expect(clamp({ x: 100, y: 100 }, SIZE, { width: 200, height: 100 }, MARGIN)).toEqual({
      x: 12,
      y: 12,
    });
  });
});

describe('magnetize', () => {
  it('snaps flush when released near an edge', () => {
    const near = magnetize({ x: 40, y: 300 }, SIZE, BOUNDS, 48, MARGIN);

    expect(near.position.x).toBe(MARGIN);
    expect(near.edge).toBe('left');
  });

  it('leaves the panel where it was dropped when it is not near anything', () => {
    const middle = magnetize({ x: 500, y: 300 }, SIZE, BOUNDS, 48, MARGIN);

    expect(middle.position).toEqual({ x: 500, y: 300 });
    expect(middle.edge).toBeNull();
  });

  it('snaps to both axes in a corner, and reports the nearer edge', () => {
    // A corner release is within threshold of two edges. Reporting the *nearer* one matters
    // because that is the edge a later resize keeps the panel pinned to.
    const corner = magnetize({ x: 30, y: 20 }, SIZE, BOUNDS, 48, MARGIN);

    expect(corner.position).toEqual({ x: MARGIN, y: MARGIN });
    expect(corner.edge).toBe('top');
  });

  it('reaches all four edges', () => {
    const right = magnetize({ x: 930, y: 300 }, SIZE, BOUNDS, 48, MARGIN);
    const bottom = magnetize({ x: 500, y: 590 }, SIZE, BOUNDS, 48, MARGIN);

    expect(right.edge).toBe('right');
    expect(right.position.x).toBe(BOUNDS.width - SIZE.width - MARGIN);
    expect(bottom.edge).toBe('bottom');
    expect(bottom.position.y).toBe(BOUNDS.height - SIZE.height - MARGIN);
  });
});

describe('toEdge', () => {
  it('keeps the other axis where the tester left it', () => {
    expect(toEdge('right', { x: 100, y: 400 }, SIZE, BOUNDS, MARGIN)).toEqual({ x: 948, y: 400 });
    expect(toEdge('top', { x: 100, y: 400 }, SIZE, BOUNDS, MARGIN)).toEqual({ x: 100, y: 12 });
  });
});

// ── The hook, through a component ──────────────────────────────────────────────────────────────

function Panel({ options }: { readonly options?: DraggableOptions }): ReactNode {
  const draggable = useDraggable(options);

  return (
    <div ref={draggable.ref} data-testid="panel" style={draggable.style}>
      <span {...draggable.handleProps} data-testid="grip">
        grip
      </span>
      <span data-testid="edge">{draggable.edge ?? 'floating'}</span>
      <span data-testid="dragging">{String(draggable.dragging)}</span>
    </div>
  );
}

/** happy-dom does no layout, so the panel has to be told how big it is. */
function stubSize(element: HTMLElement, size: { width: number; height: number }): void {
  element.getBoundingClientRect = (): DOMRect => ({
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    toJSON: () => ({}),
  });
}

function resizeTo(width: number, height: number): void {
  // happy-dom exposes its viewport control off `window.happyDOM`, which is not part of the DOM
  // lib this package compiles against — the hook itself only ever reads `window.innerWidth`.
  const controlled = window as unknown as {
    happyDOM?: { setViewport: (size: { width: number; height: number }) => void };
  };
  controlled.happyDOM?.setViewport({ width, height });

  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  resizeTo(BOUNDS.width, BOUNDS.height);
});

describe('useDraggable', () => {
  it('applies the initial position to the element on mount', () => {
    render(<Panel options={{ initial: { x: 200, y: 100 } }} />);

    expect(screen.getByTestId('panel').style.transform).toBe('translate3d(200px, 100px, 0)');
  });

  it('gives the grip a role, a tab stop and its shortcuts', () => {
    render(<Panel />);
    const grip = screen.getByTestId('grip');

    // A div with an onPointerDown is not a control. Without these a keyboard-only tester cannot
    // move the HUD off whatever it is covering.
    expect(grip.getAttribute('role')).toBe('button');
    expect(grip.tabIndex).toBe(0);
    expect(grip.getAttribute('aria-label')).toBe('Move the WisprTest panel');
    expect(grip.getAttribute('aria-keyshortcuts')).toContain('ArrowLeft');
  });

  it('writes the transform during a drag without re-rendering, and commits on release', () => {
    render(<Panel options={{ initial: { x: 400, y: 300 }, magnetThreshold: 0 }} />);
    const panel = screen.getByTestId('panel');
    const grip = screen.getByTestId('grip');
    stubSize(panel, SIZE);

    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 420, clientY: 320 });
    expect(screen.getByTestId('dragging').textContent).toBe('true');

    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 520, clientY: 380 });
    // The element moved; React was not involved.
    expect(panel.style.transform).toBe('translate3d(500px, 360px, 0)');

    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 520, clientY: 380 });
    expect(screen.getByTestId('dragging').textContent).toBe('false');
    expect(panel.style.transform).toBe('translate3d(500px, 360px, 0)');
  });

  it('captures the pointer so the drag survives leaving the handle', () => {
    render(<Panel />);
    const grip = screen.getByTestId('grip');
    const capture = vi.fn();
    grip.setPointerCapture = capture;

    fireEvent.pointerDown(grip, { button: 0, pointerId: 7, clientX: 10, clientY: 10 });

    expect(capture).toHaveBeenCalledWith(7);
  });

  it('ignores buttons other than the primary one', () => {
    render(<Panel />);
    const grip = screen.getByTestId('grip');

    fireEvent.pointerDown(grip, { button: 2, pointerId: 1, clientX: 10, clientY: 10 });

    // A right-click on the grip belongs to the context menu, not to a drag the tester cannot
    // see they have started.
    expect(screen.getByTestId('dragging').textContent).toBe('false');
  });

  it('magnets to the nearest edge on release and reports it', () => {
    const onCommit = vi.fn();
    render(<Panel options={{ initial: { x: 400, y: 300 }, onCommit }} />);
    const panel = screen.getByTestId('panel');
    const grip = screen.getByTestId('grip');
    stubSize(panel, SIZE);

    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 420, clientY: 40 });
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 420, clientY: 40 });

    expect(screen.getByTestId('edge').textContent).toBe('top');
    expect(panel.style.transform).toBe('translate3d(420px, 12px, 0)');
    expect(onCommit).toHaveBeenCalledWith({ x: 420, y: 12 }, 'top');
  });

  it('moves by arrow key, with a coarse step on shift', () => {
    render(
      <Panel options={{ initial: { x: 400, y: 300 }, keyboardStep: 16, magnetThreshold: 0 }} />,
    );
    const panel = screen.getByTestId('panel');
    stubSize(panel, SIZE);

    fireEvent.keyDown(screen.getByTestId('grip'), { key: 'ArrowRight' });
    expect(panel.style.transform).toBe('translate3d(416px, 300px, 0)');

    fireEvent.keyDown(screen.getByTestId('grip'), { key: 'ArrowDown', shiftKey: true });
    expect(panel.style.transform).toBe('translate3d(416px, 364px, 0)');
  });

  it('slams to an edge with Home and End', () => {
    render(<Panel options={{ initial: { x: 400, y: 300 } }} />);
    const panel = screen.getByTestId('panel');
    stubSize(panel, SIZE);

    fireEvent.keyDown(screen.getByTestId('grip'), { key: 'End' });
    expect(panel.style.transform).toBe('translate3d(948px, 300px, 0)');

    fireEvent.keyDown(screen.getByTestId('grip'), { key: 'Home' });
    expect(panel.style.transform).toBe('translate3d(12px, 300px, 0)');
  });

  it('leaves keys it does not own to the application under test', () => {
    render(<Panel options={{ initial: { x: 400, y: 300 } }} />);
    const panel = screen.getByTestId('panel');
    stubSize(panel, SIZE);

    fireEvent.keyDown(screen.getByTestId('grip'), { key: 'a' });

    expect(panel.style.transform).toBe('translate3d(400px, 300px, 0)');
  });

  it('re-clamps into view when the window shrinks', () => {
    render(<Panel options={{ initial: { x: 900, y: 600 }, magnetThreshold: 0 }} />);
    const panel = screen.getByTestId('panel');
    stubSize(panel, SIZE);

    resizeTo(600, 400);

    // Without this the panel is off-screen in the narrower window, and a tester cannot move a
    // panel they cannot point at.
    expect(panel.style.transform).toBe('translate3d(268px, 208px, 0)');
  });

  it('stays pinned to its edge across a resize', () => {
    render(<Panel options={{ initial: { x: 900, y: 300 } }} />);
    const panel = screen.getByTestId('panel');
    const grip = screen.getByTestId('grip');
    stubSize(panel, SIZE);

    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 900, clientY: 300 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 1250, clientY: 300 });
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 1250, clientY: 300 });
    expect(screen.getByTestId('edge').textContent).toBe('right');

    resizeTo(1000, 800);

    // Pinned to the *new* right edge, at the height the tester left it.
    expect(panel.style.transform).toBe('translate3d(668px, 300px, 0)');
  });
});
