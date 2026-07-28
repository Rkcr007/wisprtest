import type { VoiceMode } from './messages.js';

/**
 * Push-to-talk, and its toggle-mode alternative.
 *
 * A wake word is wrong for this product: testers work in open offices, and a room that starts
 * listening because someone said its name is a room that leaks the app under test into a transcript
 * and streams a colleague's call to a provider. So the tester holds a key to talk, deliberately.
 *
 * This runs in the **content script**, not the offscreen document: the offscreen document is not
 * user-visible and receives no keyboard events, while the content script sees the page's. It emits
 * intent (`onStart`/`onStop`) that the content script relays to the worker, which drives capture.
 * It is pure over an `EventTarget`, so the whole press/release/toggle logic is unit-tested in
 * happy-dom without a live extension.
 *
 * ## Not stealing the tester's keystrokes
 *
 * The chord defaults to modifiers held together (no printable character), so holding it cannot
 * insert text into the app. When the chord *does* include a printable key, its keydown is
 * `preventDefault`ed for the frame the chord completes, so the character does not also land in the
 * focused field. Losing focus (`blur`, tab hidden) releases a held key, so a push-to-talk can never
 * stick open because the tester alt-tabbed mid-word.
 */

export interface HotkeyConfig {
  readonly mode: VoiceMode;
  /**
   * The keys that must be held together, as `KeyboardEvent.key` values (e.g. `['Control', 'Shift']`
   * or `['F8']`). Configurable per the phase requirement; matched case-insensitively.
   */
  readonly keys: readonly string[];
}

export interface HotkeyHandlers {
  /** The tester wants to start talking: PTT pressed, or toggle turned on. */
  readonly onStart: () => void;
  /** The tester is done: PTT released, focus lost, or toggle turned off. */
  readonly onStop: () => void;
}

export interface Hotkey {
  dispose(): void;
}

function normalise(key: string): string {
  return key.toLowerCase();
}

export function createHotkey(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  config: HotkeyConfig,
  handlers: HotkeyHandlers,
): Hotkey {
  const required = new Set(config.keys.map(normalise));
  const pressed = new Set<string>();
  let satisfied = false;
  // Toggle mode's latched on/off, and push-to-talk's held/not, share this flag: it is whether we
  // have told the pipeline to start and not yet to stop.
  let active = false;

  function chordSatisfied(): boolean {
    for (const key of required) if (!pressed.has(key)) return false;
    return required.size > 0;
  }

  function evaluate(event: KeyboardEvent | null): void {
    const nowSatisfied = chordSatisfied();
    if (nowSatisfied === satisfied) return;
    satisfied = nowSatisfied;

    if (config.mode === 'push_to_talk') {
      if (nowSatisfied) {
        event?.preventDefault();
        active = true;
        handlers.onStart();
      } else if (active) {
        active = false;
        handlers.onStop();
      }
      return;
    }

    // Toggle: only the transition into "satisfied" acts, flipping the latch.
    if (nowSatisfied) {
      event?.preventDefault();
      active = !active;
      if (active) handlers.onStart();
      else handlers.onStop();
    }
  }

  const onKeyDown = (event: Event): void => {
    const keyboard = event as KeyboardEvent;
    // Ignore auto-repeat: a held key fires keydown repeatedly, and only the first crosses the edge.
    if (keyboard.repeat) return;
    pressed.add(normalise(keyboard.key));
    evaluate(keyboard);
  };

  const onKeyUp = (event: Event): void => {
    const keyboard = event as KeyboardEvent;
    pressed.delete(normalise(keyboard.key));
    evaluate(keyboard);
  };

  // Losing the keyboard means every key is now up as far as we can tell. Clearing the set and
  // re-evaluating releases a held push-to-talk rather than leaving the microphone latched open.
  const onLost = (): void => {
    pressed.clear();
    evaluate(null);
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onLost);
  target.addEventListener('visibilitychange', onLost);

  return {
    dispose(): void {
      if (active && config.mode === 'push_to_talk') {
        active = false;
        handlers.onStop();
      }
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onLost);
      target.removeEventListener('visibilitychange', onLost);
    },
  };
}
