import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

/**
 * `useDraggable` — the HUD's position, and how a tester changes it.
 *
 * The HUD floats over a customer's application. Wherever it starts, it will eventually cover
 * something the tester needs to see, so moving it has to be immediate and unremarkable.
 *
 * ## Why pointer capture, and why the transform is written directly
 *
 * During a drag the position is written straight to `element.style.transform` and React is not
 * told. A `setState` per `pointermove` would queue a render per frame on a page that is also
 * running the application under test; the drag would stutter exactly when the tester is trying to
 * get the HUD out of the way. React learns the position once, on release.
 *
 * Pointer capture is what makes the drag survive the pointer leaving the handle — over an iframe,
 * over a canvas, off the window. Without it, a fast drag drops the element mid-flight, and the
 * page underneath starts receiving the moves.
 *
 * ## Magnets
 *
 * Released within `magnetThreshold` of an edge, the panel snaps flush to it. A HUD parked at 3px
 * from the right edge looks like a mistake; parked *on* the edge it looks placed. All four edges,
 * because which edge is out of the way depends on the application.
 *
 * ## Keyboard
 *
 * The grip is focusable and the arrow keys move the panel, shift for a coarse step, `Home`/`End`
 * to slam it to the left or right edge. A HUD that can only be moved with a mouse is a HUD a
 * keyboard-only tester cannot get out from in front of the thing they are testing.
 */

export interface Position {
  readonly x: number;
  readonly y: number;
}

/** Which viewport edge the panel is currently flush against, if any. */
export type Edge = 'top' | 'right' | 'bottom' | 'left';

export interface DraggableOptions {
  /** Where the panel starts, in viewport pixels from the top-left. */
  readonly initial?: Position;
  /** Distance from an edge, in pixels, within which release snaps flush to it. */
  readonly magnetThreshold?: number;
  /** Gap left between the panel and the viewport edge when clamped or magneted. */
  readonly margin?: number;
  /** Pixels moved per arrow key press. Shift multiplies by {@link COARSE_STEP_MULTIPLIER}. */
  readonly keyboardStep?: number;
  /** Called once per settled position: on release, and on each keyboard move. */
  readonly onCommit?: (position: Position, edge: Edge | null) => void;
}

export interface Draggable {
  /** Attach to the element that moves. */
  readonly ref: (element: HTMLElement | null) => void;
  /**
   * Spread onto the grip. Includes the role, tabIndex and instructions that make the handle
   * operable and announced — a `div` with an `onPointerDown` is not a control.
   */
  readonly handleProps: HandleProps;
  /** The committed position. Does not update during a drag; see the module comment. */
  readonly position: Position;
  readonly dragging: boolean;
  /** The edge the panel is flush against, or null when it is floating. */
  readonly edge: Edge | null;
  /** The transform for the moving element, so the caller can apply it on first render. */
  readonly style: { readonly transform: string };
}

export interface HandleProps {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  readonly tabIndex: 0;
  readonly role: 'button';
  readonly 'aria-label': string;
  readonly 'aria-keyshortcuts': string;
}

const DEFAULT_MAGNET_THRESHOLD = 48;
const DEFAULT_MARGIN = 12;
const DEFAULT_KEYBOARD_STEP = 16;
const COARSE_STEP_MULTIPLIER = 4;

export function useDraggable(options: DraggableOptions = {}): Draggable {
  const {
    initial = { x: DEFAULT_MARGIN, y: DEFAULT_MARGIN },
    magnetThreshold = DEFAULT_MAGNET_THRESHOLD,
    margin = DEFAULT_MARGIN,
    keyboardStep = DEFAULT_KEYBOARD_STEP,
    onCommit,
  } = options;

  const [position, setPosition] = useState<Position>(initial);
  const [dragging, setDragging] = useState(false);
  const [edge, setEdge] = useState<Edge | null>(null);

  const elementRef = useRef<HTMLElement | null>(null);
  /** Mirrors `position` for the pointer handlers, which must not re-subscribe per render. */
  const positionRef = useRef<Position>(initial);
  /** Pointer offset within the element at drag start, so the panel does not jump on grab. */
  const grabOffsetRef = useRef<Position>({ x: 0, y: 0 });
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const apply = useCallback((next: Position) => {
    positionRef.current = next;
    const element = elementRef.current;
    if (element !== null) {
      // translate3d rather than top/left: it is composited, so a drag does not relayout the
      // page underneath — which on a customer's application can be genuinely expensive.
      element.style.transform = transformFor(next);
    }
  }, []);

  const commit = useCallback(
    (raw: Position) => {
      const size = measure(elementRef.current);
      const snapped = magnetize(raw, size, viewport(), magnetThreshold, margin);
      apply(snapped.position);
      setPosition(snapped.position);
      setEdge(snapped.edge);
      onCommitRef.current?.(snapped.position, snapped.edge);
    },
    [apply, magnetThreshold, margin],
  );

  const ref = useCallback((element: HTMLElement | null) => {
    elementRef.current = element;
    if (element !== null) element.style.transform = transformFor(positionRef.current);
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // Primary button only. A right-click on the grip should open the context menu, and a
      // middle-click should not start a drag the tester cannot see they have started.
      if (event.button !== 0) return;

      const element = elementRef.current;
      if (element === null) return;

      const handle = event.currentTarget;
      grabOffsetRef.current = {
        x: event.clientX - positionRef.current.x,
        y: event.clientY - positionRef.current.y,
      };
      setDragging(true);

      // Guarded because not every environment implements capture — and a drag that works without
      // it, imperfectly, is better than one that throws on pointerdown. The DOM lib declares
      // these as always present, which is why the check is on the value rather than optional.
      if (typeof handle.setPointerCapture === 'function') handle.setPointerCapture(event.pointerId);

      const size = measure(element);
      const bounds = viewport();

      const move = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== event.pointerId) return;
        apply(
          clamp(
            {
              x: moveEvent.clientX - grabOffsetRef.current.x,
              y: moveEvent.clientY - grabOffsetRef.current.y,
            },
            size,
            bounds,
            margin,
          ),
        );
      };

      const finish = (endEvent: PointerEvent): void => {
        if (endEvent.pointerId !== event.pointerId) return;
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);
        if (typeof handle.releasePointerCapture === 'function') {
          handle.releasePointerCapture(endEvent.pointerId);
        }
        setDragging(false);
        commit(positionRef.current);
      };

      // Listeners go on the handle, not the window: with the pointer captured, the handle is
      // where the events are delivered, and a window listener would also see the application's
      // own pointer traffic.
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);

      // The drag is ours now. Without this the host page starts a text selection under us.
      event.preventDefault();
    },
    [apply, commit, margin],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const step = event.shiftKey ? keyboardStep * COARSE_STEP_MULTIPLIER : keyboardStep;
      const size = measure(elementRef.current);
      const bounds = viewport();
      const current = positionRef.current;

      const next = keyboardTarget(event.key, current, step, size, bounds, margin);
      if (next === null) return;

      event.preventDefault();
      // Arrow keys must not scroll the application under test while the grip has focus.
      event.stopPropagation();
      commit(next);
    },
    [commit, keyboardStep, margin],
  );

  // Re-clamp on resize. A HUD parked against the right edge of a wide window is off-screen and
  // unreachable in a narrow one — and the tester cannot move a panel they cannot point at.
  useEffect(() => {
    const onResize = (): void => {
      const size = measure(elementRef.current);
      const bounds = viewport();
      const clamped = clamp(positionRef.current, size, bounds, margin);
      const next = edge === null ? clamped : toEdge(edge, clamped, size, bounds, margin);
      apply(next);
      setPosition(next);
    };

    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, [apply, edge, margin]);

  return {
    ref,
    handleProps: {
      onPointerDown,
      onKeyDown,
      tabIndex: 0,
      role: 'button',
      'aria-label': 'Move the WisprTest panel',
      'aria-keyshortcuts': 'ArrowUp ArrowDown ArrowLeft ArrowRight Home End',
    },
    position,
    dragging,
    edge,
    style: { transform: transformFor(position) },
  };
}

interface Size {
  readonly width: number;
  readonly height: number;
}

interface Bounds {
  readonly width: number;
  readonly height: number;
}

export function transformFor(position: Position): string {
  return `translate3d(${String(Math.round(position.x))}px, ${String(Math.round(position.y))}px, 0)`;
}

function viewport(): Bounds {
  return { width: window.innerWidth, height: window.innerHeight };
}

function measure(element: HTMLElement | null): Size {
  if (element === null) return { width: 0, height: 0 };
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

/** Keep the panel fully inside the viewport, with a margin. */
export function clamp(position: Position, size: Size, bounds: Bounds, margin: number): Position {
  const maxX = Math.max(margin, bounds.width - size.width - margin);
  const maxY = Math.max(margin, bounds.height - size.height - margin);
  return {
    x: Math.min(Math.max(position.x, margin), maxX),
    y: Math.min(Math.max(position.y, margin), maxY),
  };
}

/**
 * The position flush against one edge, keeping the other axis where it already is.
 *
 * Used on resize: a panel the tester parked against the right edge should stay against the right
 * edge of the *new* viewport, at the same height, rather than being left floating wherever the
 * old right edge happened to be.
 */
export function toEdge(
  target: Edge,
  current: Position,
  size: Size,
  bounds: Bounds,
  margin: number,
): Position {
  const right = Math.max(margin, bounds.width - size.width - margin);
  const bottom = Math.max(margin, bounds.height - size.height - margin);

  switch (target) {
    case 'left':
      return { x: margin, y: current.y };
    case 'right':
      return { x: right, y: current.y };
    case 'top':
      return { x: current.x, y: margin };
    case 'bottom':
      return { x: current.x, y: bottom };
  }
}

/**
 * Snap to the nearest edge within the threshold.
 *
 * The *nearest* edge, not the first one matched: a panel released into a corner is within
 * threshold of two edges, and picking by iteration order would move it somewhere the tester did
 * not aim. Distance decides, and both axes snap when both are close.
 */
export function magnetize(
  position: Position,
  size: Size,
  bounds: Bounds,
  threshold: number,
  margin: number,
): { position: Position; edge: Edge | null } {
  const clamped = clamp(position, size, bounds, margin);

  const distances: { edge: Edge; distance: number; apply: (p: Position) => Position }[] = [
    { edge: 'left', distance: clamped.x - margin, apply: (p) => ({ x: margin, y: p.y }) },
    {
      edge: 'right',
      distance: bounds.width - margin - (clamped.x + size.width),
      apply: (p) => ({ x: Math.max(margin, bounds.width - size.width - margin), y: p.y }),
    },
    { edge: 'top', distance: clamped.y - margin, apply: (p) => ({ x: p.x, y: margin }) },
    {
      edge: 'bottom',
      distance: bounds.height - margin - (clamped.y + size.height),
      apply: (p) => ({ x: p.x, y: Math.max(margin, bounds.height - size.height - margin) }),
    },
  ];

  const within = distances
    .filter((candidate) => candidate.distance <= threshold)
    .sort((a, b) => a.distance - b.distance);

  if (within.length === 0) return { position: clamped, edge: null };

  let next = clamped;
  for (const candidate of within) next = candidate.apply(next);

  // The nearest edge is the one reported, and the one a resize will keep the panel pinned to.
  return { position: next, edge: within[0]?.edge ?? null };
}

/** Where a key press should move the panel, or null when the key is not ours. */
function keyboardTarget(
  key: string,
  current: Position,
  step: number,
  size: Size,
  bounds: Bounds,
  margin: number,
): Position | null {
  switch (key) {
    case 'ArrowUp':
      return clamp({ x: current.x, y: current.y - step }, size, bounds, margin);
    case 'ArrowDown':
      return clamp({ x: current.x, y: current.y + step }, size, bounds, margin);
    case 'ArrowLeft':
      return clamp({ x: current.x - step, y: current.y }, size, bounds, margin);
    case 'ArrowRight':
      return clamp({ x: current.x + step, y: current.y }, size, bounds, margin);
    case 'Home':
      return { x: margin, y: current.y };
    case 'End':
      return { x: Math.max(margin, bounds.width - size.width - margin), y: current.y };
    default:
      return null;
  }
}
