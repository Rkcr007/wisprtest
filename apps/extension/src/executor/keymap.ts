import type { CdpKeyEvent } from './cdp.js';

/**
 * Character → CDP key-event translation for the `type` verb.
 *
 * Typing through `Input.dispatchKeyEvent` (rather than assigning `element.value`) is what makes the
 * keystrokes *trusted*: an application that debounces on `keydown`, masks a field, or blocks paste
 * sees exactly what a human produces. The `text` field on a `keyDown` is what actually inserts the
 * character in Chromium; the paired `keyUp` completes the stroke so key-repeat and up-handlers fire.
 *
 * The virtual key code and physical `code` are filled for the alphanumerics and the few separators
 * a QA value realistically contains, because some frameworks read `event.code`/`keyCode` rather
 * than `key`. Anything outside that set still types correctly through `text` alone — the code is a
 * refinement for the strict listeners, not a requirement for the character to land. What is *not*
 * attempted here is a full international keymap: that is a keyboard-layout problem, and the honest
 * boundary is to carry the character in `text` and annotate the common keys, not to pretend to a
 * completeness this does not have.
 */

/** The Enter key, sent to submit a text filter or a search field after typing. */
export const ENTER_KEY: CdpKeyEvent = {
  type: 'keyDown',
  key: 'Enter',
  code: 'Enter',
  text: '\r',
  windowsVirtualKeyCode: 13,
};
export const ENTER_KEY_UP: CdpKeyEvent = { ...ENTER_KEY, type: 'keyUp' };

function physicalCode(char: string): string {
  if (/^[a-zA-Z]$/.test(char)) return `Key${char.toUpperCase()}`;
  if (/^[0-9]$/.test(char)) return `Digit${char}`;
  if (char === ' ') return 'Space';
  return '';
}

function virtualKeyCode(char: string): number {
  if (/^[a-zA-Z]$/.test(char)) return char.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(char)) return char.charCodeAt(0);
  if (char === ' ') return 32;
  return 0;
}

/**
 * The down/up pair that types one character. The `text` on the `keyDown` is the load-bearing
 * field — it is what inserts the glyph — and `unmodifiedText` matches it for listeners that read
 * both.
 */
export function keyEventsForChar(char: string): readonly CdpKeyEvent[] {
  const code = physicalCode(char);
  const vk = virtualKeyCode(char);
  const down: CdpKeyEvent = {
    type: 'keyDown',
    key: char,
    text: char,
    unmodifiedText: char,
    ...(code !== '' ? { code } : {}),
    ...(vk !== 0 ? { windowsVirtualKeyCode: vk } : {}),
  };

  return [down, { ...down, type: 'keyUp' }];
}
