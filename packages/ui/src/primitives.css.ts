/**
 * Styles for the primitives, as a stylesheet string.
 *
 * A string rather than a `.css` file for the same reason the tokens are: the HUD adopts a
 * constructed stylesheet into a shadow root, where there is no document to link a file into. The
 * console imports the same text and injects it once, so both surfaces render from these exact
 * rules.
 *
 * Everything is expressed in tokens. A hard-coded colour here would be a colour that means
 * nothing, and a hard-coded duration would be one that `prefers-reduced-motion` cannot switch off.
 */
export const primitivesCss = `
.wispr-nodata {
  color: var(--wispr-text-muted);
  font-variant-numeric: tabular-nums;
}

/* ── Reticle ─────────────────────────────────────────────────────────────────────────────── */

.wispr-reticle {
  position: fixed;
  top: 0;
  left: 0;
  pointer-events: none;
  /* The spring easing is the arrival: it overshoots by a few pixels and settles. */
  transition:
    transform var(--wispr-duration-medium) var(--wispr-easing-spring),
    width var(--wispr-duration-medium) var(--wispr-easing-spring),
    height var(--wispr-duration-medium) var(--wispr-easing-spring);
}

.wispr-reticle__corner {
  position: absolute;
  width: 10px;
  height: 10px;
  border: 2px solid var(--wispr-signal);
}

.wispr-reticle--staged .wispr-reticle__corner { border-color: var(--wispr-signal); opacity: 0.7; }
.wispr-reticle--executed .wispr-reticle__corner { border-color: var(--wispr-commit); }

.wispr-reticle__corner--tl { top: -2px; left: -2px; border-right: 0; border-bottom: 0; }
.wispr-reticle__corner--tr { top: -2px; right: -2px; border-left: 0; border-bottom: 0; }
.wispr-reticle__corner--bl { bottom: -2px; left: -2px; border-right: 0; border-top: 0; }
.wispr-reticle__corner--br { bottom: -2px; right: -2px; border-left: 0; border-top: 0; }

/* ── Ghost cursor ────────────────────────────────────────────────────────────────────────── */

.wispr-ghost {
  position: fixed;
  top: 0;
  left: 0;
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  border-radius: 50%;
  background: var(--wispr-signal);
  opacity: 0.55;
  pointer-events: none;
  transition: transform var(--wispr-duration-fast) var(--wispr-easing-standard);
}

/* ── VAD bars ────────────────────────────────────────────────────────────────────────────── */

.wispr-vad {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 20px;
}

.wispr-vad__bar {
  display: block;
  width: 3px;
  height: 20px;
  border-radius: 2px;
  background: var(--wispr-signal);
  transform-origin: center;
  transition: transform var(--wispr-duration-fast) var(--wispr-easing-standard);
}

/* Closed microphone: flat and grey, so "not listening" cannot be mistaken for "a quiet room". */
.wispr-vad--idle .wispr-vad__bar { background: var(--wispr-text-muted); opacity: 0.5; }

/* ── Chip ────────────────────────────────────────────────────────────────────────────────── */

.wispr-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--wispr-space-1);
  padding: 2px var(--wispr-space-2);
  border-radius: var(--wispr-radius-sm);
  border: 1px solid var(--wispr-border);
  background: var(--wispr-surface-sunken);
  color: var(--wispr-text);
  font-size: 11px;
  line-height: 16px;
  letter-spacing: 0.02em;
  white-space: nowrap;
  transition: border-color var(--wispr-duration-fast) var(--wispr-easing-standard);
}

.wispr-chip--signal { border-color: var(--wispr-signal); color: var(--wispr-signal); }
.wispr-chip--commit { border-color: var(--wispr-commit); color: var(--wispr-commit); }
.wispr-chip--seed   { border-color: var(--wispr-seed);   color: var(--wispr-seed); }
.wispr-chip--memory { border-color: var(--wispr-memory); color: var(--wispr-memory); }
.wispr-chip--drift  { border-color: var(--wispr-drift);  color: var(--wispr-drift); }

/* ── Cell ────────────────────────────────────────────────────────────────────────────────── */

.wispr-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.wispr-cell__label {
  color: var(--wispr-text-muted);
  font-size: 10px;
  line-height: 14px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.wispr-cell__value {
  color: var(--wispr-text);
  font-size: 12px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wispr-cell__value--signal { color: var(--wispr-signal); }
.wispr-cell__value--commit { color: var(--wispr-commit); }
.wispr-cell__value--seed   { color: var(--wispr-seed); }
.wispr-cell__value--memory { color: var(--wispr-memory); }
.wispr-cell__value--drift  { color: var(--wispr-drift); }

.wispr-cell__unit {
  color: var(--wispr-text-muted);
  font-size: 10px;
  margin-left: 2px;
}

/* ── Toast ───────────────────────────────────────────────────────────────────────────────── */

.wispr-toast {
  display: flex;
  align-items: flex-start;
  gap: var(--wispr-space-2);
  padding: var(--wispr-space-2) var(--wispr-space-3);
  border-radius: var(--wispr-radius-md);
  border: 1px solid var(--wispr-border);
  border-left-width: 3px;
  background: var(--wispr-surface-raised);
  color: var(--wispr-text);
  font-size: 12px;
  line-height: 16px;
}

.wispr-toast--signal { border-left-color: var(--wispr-signal); }
.wispr-toast--commit { border-left-color: var(--wispr-commit); }
.wispr-toast--seed   { border-left-color: var(--wispr-seed); }
.wispr-toast--memory { border-left-color: var(--wispr-memory); }
.wispr-toast--drift  { border-left-color: var(--wispr-drift); }

.wispr-toast__body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.wispr-toast__title { font-weight: 600; }
.wispr-toast__detail { color: var(--wispr-text-muted); }

.wispr-toast__dismiss {
  margin-left: auto;
  padding: 2px var(--wispr-space-2);
  border-radius: var(--wispr-radius-sm);
  border: 1px solid var(--wispr-border);
  background: transparent;
  color: var(--wispr-text-muted);
  font: inherit;
  cursor: pointer;
}

.wispr-toast__dismiss:hover { color: var(--wispr-text); }

/* ── Focus ───────────────────────────────────────────────────────────────────────────────── */

/*
 * One focus treatment for everything in the design system. White rather than a palette colour,
 * because focus is not one of the five things the palette means — and an amber focus ring on a
 * mint control would read as "aiming" at something that has already run.
 */
:where(button, [tabindex], [role='button']):focus-visible {
  outline: 2px solid var(--wispr-focus-ring);
  outline-offset: 2px;
}
`;
