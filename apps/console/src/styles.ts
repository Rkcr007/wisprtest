/**
 * The console's stylesheet.
 *
 * Emitted as a string and inlined by the root layout, the same way `packages/ui` emits its
 * tokens and primitives — the HUD adopts that text into a shadow root and the console puts it in
 * a `<style>`. One representation, one place the design system lives.
 *
 * Every colour, space, radius and duration below is a `var(--wispr-…)` from `packages/ui`.
 * Nothing here introduces a value of its own except the page's black base, which is the
 * background the translucent surface tokens were designed to sit on.
 *
 * Motion: durations resolve to `0ms` under `prefers-reduced-motion` because the token stylesheet
 * redefines them there. No rule in this file needs to know that.
 */
export const consoleCss = `
*, *::before, *::after { box-sizing: border-box; }

html {
  background: #000;
  color-scheme: dark;
}

body {
  margin: 0;
  min-height: 100vh;
  background: var(--wispr-surface-sunken);
  color: var(--wispr-text);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}

:focus-visible {
  outline: 2px solid var(--wispr-focus-ring);
  outline-offset: 2px;
  border-radius: var(--wispr-radius-sm);
}

/* A keyboard user reaches the content without walking the header first. */
.skip-link {
  position: absolute;
  left: var(--wispr-space-2);
  top: calc(-1 * var(--wispr-space-4) - 40px);
  z-index: 10;
  padding: var(--wispr-space-2) var(--wispr-space-3);
  background: var(--wispr-surface-raised);
  border: 1px solid var(--wispr-border);
  border-radius: var(--wispr-radius-sm);
  color: var(--wispr-text);
  transition: top var(--wispr-duration-fast) var(--wispr-easing-standard);
}
.skip-link:focus { top: var(--wispr-space-2); }

.masthead {
  display: flex;
  align-items: center;
  gap: var(--wispr-space-3);
  padding: var(--wispr-space-3) var(--wispr-space-4);
  border-bottom: 1px solid var(--wispr-border);
  background: var(--wispr-surface);
}
.masthead h1 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.masthead .spacer { flex: 1; }
.masthead nav { display: flex; gap: var(--wispr-space-3); }

.shell {
  max-width: 1080px;
  margin: 0 auto;
  padding: var(--wispr-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--wispr-space-4);
}

.card {
  background: var(--wispr-surface);
  border: 1px solid var(--wispr-border);
  border-radius: var(--wispr-radius-md);
  padding: var(--wispr-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--wispr-space-3);
}
.card > h2 { margin: 0; font-size: 14px; font-weight: 600; }
.card > h3 { margin: 0; font-size: 13px; font-weight: 600; }
.hint { margin: 0; color: var(--wispr-text-muted); font-size: 12px; }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--wispr-space-3);
}

.field { display: flex; flex-direction: column; gap: var(--wispr-space-1); }
.field > label { font-size: 12px; color: var(--wispr-text-muted); }
.field > .hint { font-size: 11px; }

input[type="text"], input[type="number"], input[type="url"], textarea, select {
  width: 100%;
  padding: var(--wispr-space-2);
  background: var(--wispr-surface-sunken);
  color: var(--wispr-text);
  border: 1px solid var(--wispr-border);
  border-radius: var(--wispr-radius-sm);
  font: inherit;
  font-variant-numeric: tabular-nums;
}
textarea { min-height: 72px; resize: vertical; font-family: ui-monospace, SFMono-Regular, monospace; }
input[aria-invalid="true"], textarea[aria-invalid="true"] { border-color: var(--wispr-drift); }

.error {
  color: var(--wispr-drift);
  font-size: 12px;
}

fieldset {
  margin: 0;
  padding: var(--wispr-space-3);
  border: 1px solid var(--wispr-border);
  border-radius: var(--wispr-radius-sm);
  display: flex;
  flex-direction: column;
  gap: var(--wispr-space-2);
}
legend { padding: 0 var(--wispr-space-1); font-size: 12px; color: var(--wispr-text-muted); }
.radio-row { display: flex; gap: var(--wispr-space-4); flex-wrap: wrap; }
.radio-row label { display: flex; gap: var(--wispr-space-1); align-items: center; }

details > summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--wispr-text-muted);
  padding: var(--wispr-space-1) 0;
}
details[open] > summary { margin-bottom: var(--wispr-space-2); }

button {
  font: inherit;
  padding: var(--wispr-space-2) var(--wispr-space-3);
  border-radius: var(--wispr-radius-sm);
  border: 1px solid var(--wispr-border);
  background: var(--wispr-surface-raised);
  color: var(--wispr-text);
  cursor: pointer;
  transition: background var(--wispr-duration-fast) var(--wispr-easing-standard);
}
button:hover:not(:disabled) { background: var(--wispr-surface-sunken); }
button:disabled { opacity: 0.5; cursor: progress; }
button.primary {
  background: var(--wispr-signal);
  border-color: var(--wispr-signal);
  /* Dark ink on the amber, which is the only way this clears AA on a colour that bright. */
  color: #16181d;
  font-weight: 600;
}
button.primary:hover:not(:disabled) { background: var(--wispr-signal); filter: brightness(1.08); }

a { color: var(--wispr-memory); }

.chips { display: flex; flex-wrap: wrap; gap: var(--wispr-space-2); }
.chip {
  display: inline-flex;
  align-items: baseline;
  gap: var(--wispr-space-1);
  padding: var(--wispr-space-1) var(--wispr-space-2);
  border: 1px solid var(--wispr-border);
  border-radius: var(--wispr-radius-sm);
  background: var(--wispr-surface-sunken);
  font-size: 12px;
}
.chip .value { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.chip.signal .value { color: var(--wispr-signal); }
.chip.commit .value { color: var(--wispr-commit); }
.chip.memory .value { color: var(--wispr-memory); }
.chip.drift .value { color: var(--wispr-drift); }

.bar {
  height: 8px;
  border-radius: var(--wispr-radius-sm);
  background: var(--wispr-surface-sunken);
  border: 1px solid var(--wispr-border);
  overflow: hidden;
}
.bar > .fill {
  height: 100%;
  background: var(--wispr-signal);
  transition: width var(--wispr-duration-medium) var(--wispr-easing-standard);
}
.bar.done > .fill { background: var(--wispr-commit); }
.bar.failed > .fill { background: var(--wispr-drift); }
.bar.indeterminate > .fill {
  width: 30%;
  background: var(--wispr-signal);
  animation: sweep 1.6s var(--wispr-easing-standard) infinite;
}
@keyframes sweep {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(333%); }
}
@media (prefers-reduced-motion: reduce) {
  /* The sweep is decorative; the text beside it carries the same information. */
  .bar.indeterminate > .fill { animation: none; width: 100%; opacity: 0.35; }
}

table { width: 100%; border-collapse: collapse; font-size: 13px; }
caption { text-align: left; color: var(--wispr-text-muted); font-size: 12px; padding-bottom: var(--wispr-space-2); }
th, td {
  text-align: left;
  padding: var(--wispr-space-2);
  border-bottom: 1px solid var(--wispr-border);
  vertical-align: top;
}
th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--wispr-text-muted); font-weight: 600; }
td.numeric, th.numeric { text-align: right; font-variant-numeric: tabular-nums; }
td.path { font-family: ui-monospace, SFMono-Regular, monospace; word-break: break-all; }
.status-indexed { color: var(--wispr-commit); }
.status-crawling { color: var(--wispr-signal); }
.status-skipped { color: var(--wispr-text-muted); }

.scroll { max-height: 420px; overflow-y: auto; }

/* Skeletons mirror the final layout: same rows, same columns, same heights. */
.skeleton {
  background: var(--wispr-surface-raised);
  border-radius: var(--wispr-radius-sm);
  height: 1em;
  animation: pulse 1.4s var(--wispr-easing-standard) infinite;
}
@keyframes pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.8; } }
@media (prefers-reduced-motion: reduce) {
  .skeleton { animation: none; opacity: 0.55; }
}

.visually-hidden {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
`;
