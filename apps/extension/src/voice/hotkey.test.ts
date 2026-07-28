import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { createHotkey } from './hotkey.js';

/**
 * The hotkey is pure over an `EventTarget`, so happy-dom's `KeyboardEvent` drives the whole
 * press/release/toggle/blur logic without a live extension.
 */

function keydown(key: string, repeat = false): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, repeat, cancelable: true });
}
function keyup(key: string): KeyboardEvent {
  return new KeyboardEvent('keyup', { key, cancelable: true });
}

let target: EventTarget;
let onStart: Mock<() => void>;
let onStop: Mock<() => void>;

beforeEach(() => {
  target = new EventTarget();
  onStart = vi.fn<() => void>();
  onStop = vi.fn<() => void>();
});

describe('push-to-talk', () => {
  it('starts on press and stops on release', () => {
    createHotkey(target, { mode: 'push_to_talk', keys: ['Control'] }, { onStart, onStop });

    target.dispatchEvent(keydown('Control'));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();

    target.dispatchEvent(keyup('Control'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('ignores auto-repeat so a held key does not re-trigger', () => {
    createHotkey(target, { mode: 'push_to_talk', keys: ['Control'] }, { onStart, onStop });
    target.dispatchEvent(keydown('Control'));
    target.dispatchEvent(keydown('Control', true)); // OS auto-repeat
    target.dispatchEvent(keydown('Control', true));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('fires only once the whole chord is held, case-insensitively', () => {
    createHotkey(target, { mode: 'push_to_talk', keys: ['Control', 'Shift'] }, { onStart, onStop });

    target.dispatchEvent(keydown('control')); // partial chord
    expect(onStart).not.toHaveBeenCalled();

    target.dispatchEvent(keydown('shift')); // chord complete
    expect(onStart).toHaveBeenCalledTimes(1);

    target.dispatchEvent(keyup('shift')); // chord broken
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('releases a held key when focus is lost, so the mic cannot stick open', () => {
    createHotkey(target, { mode: 'push_to_talk', keys: ['Control'] }, { onStart, onStop });
    target.dispatchEvent(keydown('Control'));
    target.dispatchEvent(new Event('blur'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('stops an active press on dispose', () => {
    const hotkey = createHotkey(
      target,
      { mode: 'push_to_talk', keys: ['Control'] },
      { onStart, onStop },
    );
    target.dispatchEvent(keydown('Control'));
    hotkey.dispose();
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe('toggle mode', () => {
  it('latches on the first press and unlatches on the next, ignoring releases', () => {
    createHotkey(target, { mode: 'toggle', keys: ['F8'] }, { onStart, onStop });

    target.dispatchEvent(keydown('F8'));
    expect(onStart).toHaveBeenCalledTimes(1);
    target.dispatchEvent(keyup('F8')); // release does not stop in toggle mode
    expect(onStop).not.toHaveBeenCalled();

    target.dispatchEvent(keydown('F8')); // second press toggles off
    expect(onStop).toHaveBeenCalledTimes(1);
    target.dispatchEvent(keyup('F8'));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('does not stop on dispose because a toggle is not a held key', () => {
    const hotkey = createHotkey(target, { mode: 'toggle', keys: ['F8'] }, { onStart, onStop });
    target.dispatchEvent(keydown('F8'));
    hotkey.dispose();
    expect(onStop).not.toHaveBeenCalled();
  });
});
