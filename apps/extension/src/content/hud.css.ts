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

/* Confirmed speech: a finalized transcript reads as settled, in the primary text colour. */
.wispr-hud__transcript-final { color: var(--wispr-text); }

/*
 * The unconfirmed tail — the in-flight hypothesis that may still be revised. Rendered in the
 * signal amber the reticle uses while aiming, and de-emphasised, so a tester can see at a glance
 * which words are committed and which the system is still hearing. This is the phase requirement:
 * the tail must be visually distinguished from the confirmed transcript.
 */
.wispr-hud__transcript-tail {
  color: var(--wispr-signal);
  opacity: 0.85;
}

.wispr-hud__transcript-final + .wispr-hud__transcript-tail { margin-left: 4px; }

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

/* ── Disambiguation: the numbered choice, shown only while one is open ───────────────────── */

.wispr-hud__disambiguation { display: flex; flex-direction: column; gap: var(--wispr-space-1); }
.wispr-hud__disambiguation > div { display: flex; gap: var(--wispr-space-1); flex-wrap: wrap; }

/* The spoken word carries the choice, so it leads. The memory token is the palette's "stored
   knowledge", which is what answering this becomes: an alias the tester just taught the system. */
.wispr-hud__ordinal { color: var(--wispr-memory); font-variant-caps: all-small-caps; }

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

/* ── Seed preview: what the tester is being asked to approve ─────────────────────────────── */

/*
 * The seed token throughout, because that is what it means. tokens.ts describes it as "everywhere
 * generated data appears: the seed preview, the ledger, and the created rows in the application
 * itself" — one colour connecting the card, the record it creates and the mark drawn over that
 * record on screen, so a tester follows one visual thread from approval to result.
 *
 * A scroll ceiling rather than an unbounded list: a multi-entity plan can carry a dozen fields per
 * record, and a card that grows past the viewport puts its own approve button off-screen.
 */
.wispr-seed {
  display: flex;
  flex-direction: column;
  gap: var(--wispr-space-2);
  border-left: 2px solid var(--wispr-seed);
  max-height: 46vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.wispr-seed__head { display: flex; align-items: center; gap: var(--wispr-space-2); }
.wispr-seed__count { color: var(--wispr-text-muted); font-size: 11px; margin-left: auto; }

.wispr-seed__utterance {
  color: var(--wispr-text-muted);
  font-size: 11px;
  line-height: 15px;
  font-style: italic;
}

.wispr-seed__answer, .wispr-seed__error {
  font-size: 11px;
  line-height: 15px;
  color: var(--wispr-text);
}
.wispr-seed__error { color: var(--wispr-drift); }

.wispr-seed__nodes, .wispr-seed__fields, .wispr-seed__attempts, .wispr-seed__reverted {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--wispr-space-1);
}

.wispr-seed__node {
  display: flex;
  flex-direction: column;
  gap: var(--wispr-space-1);
  padding: var(--wispr-space-2);
  border: 1px solid var(--wispr-border);
  border-radius: var(--wispr-radius-md);
  background: var(--wispr-surface-sunken);
}

.wispr-seed__node-head { display: flex; align-items: center; gap: var(--wispr-space-2); }

/* Numbered because a plan is a graph and the order is the order the records will be created in. */
.wispr-seed__node-ordinal {
  color: var(--wispr-seed);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  min-width: 12px;
}

.wispr-seed__node-entity { font-size: 12px; font-weight: 600; }

.wispr-seed__adapter-why, .wispr-seed__revert {
  font-size: 11px;
  line-height: 15px;
  color: var(--wispr-text-muted);
}

/* An unrevertable record is a decision, not a detail. It reads in the drift colour — the palette's
   "something is wrong with what we know" — because approving one is not undoable. */
.wispr-seed__revert--none { color: var(--wispr-drift); }

.wispr-seed__warning {
  font-size: 11px;
  line-height: 15px;
  color: var(--wispr-drift);
  padding: var(--wispr-space-1) var(--wispr-space-2);
  border: 1px solid var(--wispr-drift);
  border-radius: var(--wispr-radius-sm);
}

.wispr-seed__field { display: flex; flex-direction: column; gap: 2px; }
.wispr-seed__field-head { display: flex; align-items: center; gap: var(--wispr-space-2); }
.wispr-seed__field-name { color: var(--wispr-text-muted); font-size: 11px; min-width: 84px; }
.wispr-seed__field-value {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

/* The explanation is the whole reason the card is trustworthy, so it is never truncated. */
.wispr-seed__field-why {
  font-size: 10px;
  line-height: 14px;
  color: var(--wispr-text-muted);
  padding-left: 84px;
}

.wispr-seed__attempt { display: flex; align-items: center; gap: var(--wispr-space-2); }
.wispr-seed__attempt-why { font-size: 10px; color: var(--wispr-text-muted); }

.wispr-seed__created { font-size: 11px; line-height: 15px; color: var(--wispr-seed); }

.wispr-seed__actions { display: flex; gap: var(--wispr-space-1); flex-wrap: wrap; }

/* ── The mark drawn over a created record in the application under test ──────────────────── */

/*
 * Fixed, so it tracks the viewport the same way the rect it was measured from does, and
 * pointer-events none so the row underneath stays clickable — the tester has to be able to open
 * the record we just drew a box around.
 */
.wispr-seed-mark {
  position: fixed;
  border: 2px solid var(--wispr-seed);
  border-radius: var(--wispr-radius-sm);
  pointer-events: none;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
  transition: opacity var(--wispr-duration-fast) var(--wispr-easing-standard);
}

.wispr-seed-mark__label {
  position: absolute;
  top: -9px;
  left: 6px;
  padding: 0 4px;
  background: var(--wispr-surface);
  color: var(--wispr-seed);
  font-size: 9px;
  line-height: 12px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border-radius: 3px;
  white-space: nowrap;
}
`;
