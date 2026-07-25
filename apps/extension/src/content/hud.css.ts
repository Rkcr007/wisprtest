/**
 * The HUD's own styles.
 *
 * Everything here is expressed in `packages/ui` tokens: the HUD is one consumer of the design
 * system, not a second design system. Layout lives here because the console's surfaces are not
 * this shape — three bands over a customer's application is specific to the overlay.
 *
 * These rules only ever apply inside the shadow root. The selectors are still narrow and
 * class-based rather than element-based, so that if this stylesheet is ever adopted somewhere
 * without a shadow boundary it cannot restyle a host document by accident.
 */
export const hudCss = `
/*
 * The container spans the viewport so the panel can be positioned anywhere in it, and passes
 * every pointer event straight through. Only the panel itself takes input — a full-viewport
 * overlay that swallowed clicks would make the application untestable, which is a memorable way
 * to fail at being a testing tool.
 */
.wispr-hud-root {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: var(--wispr-z-hud);
  font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: var(--wispr-text);
}

.wispr-hud {
  position: absolute;
  top: 0;
  left: 0;
  width: 340px;
  pointer-events: auto;
  background: var(--wispr-surface);
  border: 1px solid var(--wispr-border);
  border-radius: var(--wispr-radius-lg);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(8px);
  overflow: hidden;
  transition: width var(--wispr-duration-medium) var(--wispr-easing-standard);
}

.wispr-hud--collapsed { width: 152px; }
.wispr-hud--dragging { transition: none; }

/* ── Band 1: grip, orb, VAD, transcript, state ───────────────────────────────────────────── */

.wispr-hud__band {
  display: flex;
  align-items: center;
  gap: var(--wispr-space-2);
  padding: var(--wispr-space-2) var(--wispr-space-3);
}

.wispr-hud__band + .wispr-hud__band { border-top: 1px solid var(--wispr-border); }

.wispr-hud__grip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--wispr-space-1) 2px;
  border-radius: var(--wispr-radius-sm);
  cursor: grab;
  flex: none;
}

.wispr-hud__grip:active { cursor: grabbing; }
.wispr-hud__grip-line { display: block; width: 10px; height: 1px; background: var(--wispr-text-muted); }

/*
 * The orb is the attach state, at a glance and from across a desk. Grey detached, amber while
 * attaching, mint attached, orange-red failed — the same vocabulary as everywhere else.
 */
.wispr-hud__orb {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex: none;
  background: var(--wispr-text-muted);
  transition: background var(--wispr-duration-fast) var(--wispr-easing-standard);
}

.wispr-hud__orb--attaching { background: var(--wispr-signal); }
.wispr-hud__orb--attached  { background: var(--wispr-commit); }
.wispr-hud__orb--failed    { background: var(--wispr-drift); }

.wispr-hud__transcript {
  flex: 1 1 auto;
  min-width: 0;
  padding: var(--wispr-space-1) var(--wispr-space-2);
  border-radius: var(--wispr-radius-sm);
  background: var(--wispr-surface-sunken);
  color: var(--wispr-text-muted);
  font-size: 12px;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wispr-hud__actions { display: flex; gap: var(--wispr-space-1); margin-left: auto; flex: none; }

.wispr-hud__button {
  padding: 2px var(--wispr-space-2);
  border-radius: var(--wispr-radius-sm);
  border: 1px solid var(--wispr-border);
  background: var(--wispr-surface-sunken);
  color: var(--wispr-text);
  font: inherit;
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
  transition: border-color var(--wispr-duration-fast) var(--wispr-easing-standard);
}

.wispr-hud__button:hover { border-color: var(--wispr-text-muted); }
.wispr-hud__button:disabled { opacity: 0.5; cursor: default; }
.wispr-hud__button--primary { border-color: var(--wispr-memory); color: var(--wispr-memory); }

/* ── Band 2: intent ──────────────────────────────────────────────────────────────────────── */

.wispr-hud__intent { display: flex; flex-direction: column; gap: var(--wispr-space-1); }
.wispr-hud__intent-row { display: flex; align-items: center; gap: var(--wispr-space-2); }
.wispr-hud__intent-label {
  color: var(--wispr-text-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  min-width: 52px;
}

/* ── Band 3: telemetry ───────────────────────────────────────────────────────────────────── */

.wispr-hud__telemetry {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--wispr-space-2) var(--wispr-space-3);
  width: 100%;
}

.wispr-hud__note {
  padding: 0 var(--wispr-space-3) var(--wispr-space-2);
  color: var(--wispr-text-muted);
  font-size: 11px;
  line-height: 15px;
}

.wispr-hud__toast-slot { padding: 0 var(--wispr-space-3) var(--wispr-space-3); }
`;
