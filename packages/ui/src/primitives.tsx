import type { ReactNode } from 'react';

/**
 * HUD primitives.
 *
 * Six components, shared by the extension HUD and the console. They are small on purpose: every
 * one of them encodes a piece of the product's vocabulary — what a colour means, what an empty
 * value means, what gets announced to a screen reader — and that vocabulary has to be identical
 * in both surfaces or a tester learns it twice.
 *
 * ## Conventions every primitive here holds to
 *
 * - **Tone is meaning.** `tone` selects a palette token, and the palette tokens mean specific
 *   things (see `tokens.ts`). There is no `tone="primary"`, because "primary" is not a fact
 *   about what happened.
 * - **Empty is stated, not implied.** A value that does not exist yet renders an em dash with an
 *   accessible label saying so. A zero would be a claim — "no resolutions have happened" reads
 *   very differently from "resolution is not wired up yet", and only one of them is true here.
 * - **Announced when it matters, silent when it does not.** Decoration is `aria-hidden`;
 *   anything that changes without the tester acting is in a live region.
 * - **Motion via tokens.** Transitions interpolate `--wispr-duration-*`, which the token
 *   stylesheet zeroes under `prefers-reduced-motion`. No component checks for it itself.
 */

/** The five product colours, as a component-facing choice. */
export type Tone = 'signal' | 'commit' | 'seed' | 'memory' | 'drift' | 'neutral';

/** Rendered for a value that does not exist yet, with the reason available to assistive tech. */
export function NoData({ label = 'no data yet' }: { readonly label?: string }): ReactNode {
  return (
    <span className="wispr-nodata" aria-label={label}>
      —
    </span>
  );
}

// ── Reticle ────────────────────────────────────────────────────────────────────────────────────

/** Where the reticle is drawn, in viewport pixels. */
export interface ReticleRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ReticleProps {
  /** Null hides the reticle: there is nothing being aimed at. */
  readonly rect: ReticleRect | null;
  /**
   * `aiming` while the system believes it knows the target, `staged` when the action needs
   * confirmation before it can run, `executed` immediately after it ran.
   *
   * These map to the reversibility taxonomy: a class C action can reach `staged` and can never
   * reach `executed` without an explicit confirmation, so the colour a tester sees is a truthful
   * report of whether anything happened.
   */
  readonly state?: 'aiming' | 'staged' | 'executed';
  /** Describes the target for assistive technology. The brackets themselves are decoration. */
  readonly label?: string;
}

/**
 * Four corner brackets around the element the system is aiming at.
 *
 * Brackets rather than a filled box or an outline: a box obscures the thing it is pointing at,
 * and the tester needs to read the button they are about to press. The spring easing is doing a
 * job too — the overshoot-and-settle is what makes the reticle read as having *arrived*
 * somewhere, rather than having been repainted.
 */
export function Reticle({ rect, state = 'aiming', label }: ReticleProps): ReactNode {
  if (rect === null) return null;

  return (
    <div
      className={`wispr-reticle wispr-reticle--${state}`}
      style={{
        transform: `translate3d(${String(Math.round(rect.x))}px, ${String(Math.round(rect.y))}px, 0)`,
        width: `${String(Math.round(rect.width))}px`,
        height: `${String(Math.round(rect.height))}px`,
      }}
      // The brackets are decoration; the label below is what is announced.
      aria-hidden={label === undefined ? true : undefined}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      data-testid="wispr-reticle"
    >
      <span className="wispr-reticle__corner wispr-reticle__corner--tl" />
      <span className="wispr-reticle__corner wispr-reticle__corner--tr" />
      <span className="wispr-reticle__corner wispr-reticle__corner--bl" />
      <span className="wispr-reticle__corner wispr-reticle__corner--br" />
    </div>
  );
}

// ── GhostCursor ────────────────────────────────────────────────────────────────────────────────

export interface GhostCursorProps {
  readonly x: number;
  readonly y: number;
  readonly visible?: boolean;
}

/**
 * A translucent pointer showing where the system is about to act.
 *
 * Always decoration — it duplicates information the reticle already carries, for the tester's
 * peripheral vision — so it is hidden from assistive technology rather than announced twice.
 */
export function GhostCursor({ x, y, visible = true }: GhostCursorProps): ReactNode {
  if (!visible) return null;

  return (
    <div
      className="wispr-ghost"
      style={{
        transform: `translate3d(${String(Math.round(x))}px, ${String(Math.round(y))}px, 0)`,
      }}
      aria-hidden
      data-testid="wispr-ghost-cursor"
    />
  );
}

// ── VadBars ────────────────────────────────────────────────────────────────────────────────────

export interface VadBarsProps {
  /** Voice activity level in [0, 1], or null when the microphone is not open. */
  readonly level: number | null;
  readonly bars?: number;
  readonly label?: string;
}

const DEFAULT_BARS = 5;

/**
 * Voice activity, as a row of bars.
 *
 * `level: null` means the microphone is closed — rendered as flat bars rather than as silence,
 * because "not listening" and "listening to a quiet room" must not look the same. Exposed as a
 * `meter`, whose `aria-valuetext` says which of the two it is.
 */
export function VadBars({
  level,
  bars = DEFAULT_BARS,
  label = 'Voice activity',
}: VadBarsProps): ReactNode {
  const clamped = level === null ? 0 : Math.min(Math.max(level, 0), 1);

  return (
    <div
      className={`wispr-vad${level === null ? ' wispr-vad--idle' : ''}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuetext={
        level === null ? 'microphone closed' : `${String(Math.round(clamped * 100))}%`
      }
      data-testid="wispr-vad"
    >
      {Array.from({ length: bars }, (_unused, index) => {
        // Bars fill from the centre outwards, so the shape reads as a level meter rather than a
        // progress bar — nothing here is progressing towards completion.
        const distance = Math.abs(index - (bars - 1) / 2) / ((bars - 1) / 2 || 1);
        const height = level === null ? 0.12 : Math.max(0.12, clamped * (1 - distance * 0.55));
        return (
          <span
            key={index}
            className="wispr-vad__bar"
            style={{ transform: `scaleY(${height.toFixed(3)})` }}
          />
        );
      })}
    </div>
  );
}

// ── Chip ───────────────────────────────────────────────────────────────────────────────────────

export interface ChipProps {
  readonly tone?: Tone;
  readonly children: ReactNode;
  /** Marks the chip as reporting a state that changes on its own, so it is announced politely. */
  readonly live?: boolean;
  readonly title?: string;
}

/** A short labelled state: the attach state, the active tier, the action class. */
export function Chip({ tone = 'neutral', children, live = false, title }: ChipProps): ReactNode {
  return (
    <span
      className={`wispr-chip wispr-chip--${tone}`}
      title={title}
      aria-live={live ? 'polite' : undefined}
      data-tone={tone}
    >
      {children}
    </span>
  );
}

// ── Cell ───────────────────────────────────────────────────────────────────────────────────────

export interface CellProps {
  readonly label: string;
  /** `null` renders the no-data dash. Pass it deliberately rather than passing a zero. */
  readonly value: ReactNode | null;
  readonly tone?: Tone;
  /** Unit suffix, rendered muted: `ms`, `%`. */
  readonly unit?: string;
}

/**
 * One labelled reading in the telemetry band.
 *
 * The `null` case matters more than it looks. Several of these cells report things that later
 * phases produce — tier distribution, resolution latency — and rendering `0` for them would be a
 * measurement nobody took. The dash says "nothing to report yet" and is announced as such.
 */
export function Cell({ label, value, tone = 'neutral', unit }: CellProps): ReactNode {
  return (
    <div className="wispr-cell" data-tone={tone}>
      <span className="wispr-cell__label">{label}</span>
      <span className={`wispr-cell__value wispr-cell__value--${tone}`}>
        {value === null ? <NoData /> : value}
        {value !== null && unit !== undefined ? (
          <span className="wispr-cell__unit">{unit}</span>
        ) : null}
      </span>
    </div>
  );
}

// ── Toast ──────────────────────────────────────────────────────────────────────────────────────

export interface ToastProps {
  readonly tone?: Tone;
  readonly title: string;
  readonly detail?: string;
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
}

/**
 * A transient message.
 *
 * `drift` tone is an `alert` and everything else is a `status`: an alert interrupts a screen
 * reader mid-sentence, which is right for "the application changed under you" and wrong for
 * "attached". Drift still must not *block* — it interrupts the announcement, not the tester.
 */
export function Toast({
  tone = 'neutral',
  title,
  detail,
  onDismiss,
  dismissLabel = 'Dismiss',
}: ToastProps): ReactNode {
  return (
    <div
      className={`wispr-toast wispr-toast--${tone}`}
      role={tone === 'drift' ? 'alert' : 'status'}
      aria-live={tone === 'drift' ? 'assertive' : 'polite'}
      data-testid="wispr-toast"
    >
      <div className="wispr-toast__body">
        <span className="wispr-toast__title">{title}</span>
        {detail === undefined ? null : <span className="wispr-toast__detail">{detail}</span>}
      </div>
      {onDismiss === undefined ? null : (
        <button type="button" className="wispr-toast__dismiss" onClick={onDismiss}>
          {dismissLabel}
        </button>
      )}
    </div>
  );
}
