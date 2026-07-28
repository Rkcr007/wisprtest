import { describe, expect, it, vi } from 'vitest';

import { captureRollback, type RollbackContext } from './rollback.js';

// The focus/type/select cases read only the element (and its document), so the real window serves;
// the scroll and history cases pass their own minimal fake windows inline.
const ctx = (): RollbackContext => ({ window });

describe('captureRollback', () => {
  it('restores a field value and re-fires input for type', () => {
    const input = document.createElement('input');
    input.value = 'old';
    document.body.append(input);

    const record = captureRollback('type', input, ctx());
    expect(record).not.toBeNull();

    const listener = vi.fn();
    input.addEventListener('input', listener);
    input.value = 'new speculative text';

    record?.apply();

    expect(input.value).toBe('old');
    expect(listener).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it('restores a select value and re-fires change', () => {
    const select = document.createElement('select');
    for (const v of ['pending', 'approved']) {
      const option = document.createElement('option');
      option.value = v;
      select.append(option);
    }
    select.value = 'pending';
    document.body.append(select);

    const record = captureRollback('select', select, ctx());
    const listener = vi.fn();
    select.addEventListener('change', listener);
    select.value = 'approved';

    record?.apply();

    expect(select.value).toBe('pending');
    expect(listener).toHaveBeenCalledTimes(1);
    select.remove();
  });

  it('refocuses the previously focused element for focus', () => {
    const a = document.createElement('button');
    const b = document.createElement('button');
    document.body.append(a, b);
    a.focus();
    expect(document.activeElement).toBe(a);

    const record = captureRollback('focus', b, ctx());
    b.focus();
    expect(document.activeElement).toBe(b);

    record?.apply();
    expect(document.activeElement).toBe(a);
    a.remove();
    b.remove();
  });

  it('scrolls the window back to its prior offset for scroll', () => {
    const scrollTo = vi.fn();
    const record = captureRollback('scroll', document.createElement('div'), {
      window: { scrollX: 0, scrollY: 120, scrollTo } as unknown as Window,
    });
    record?.apply();
    expect(scrollTo).toHaveBeenCalledWith(0, 120);
  });

  it('steps history the opposite way for navigate and back', () => {
    const back = vi.fn();
    const forward = vi.fn();
    const win = { history: { back, forward } } as unknown as Window;

    captureRollback('navigate', document.createElement('a'), { window: win })?.apply();
    expect(back).toHaveBeenCalledTimes(1);

    captureRollback('back', document.createElement('a'), { window: win })?.apply();
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it('has nothing to undo for an assertion or a click', () => {
    expect(captureRollback('check', document.createElement('div'), ctx())).toBeNull();
    // A click is class C: it is never speculative, so it never has a rollback record.
    expect(captureRollback('click', document.createElement('button'), ctx())).toBeNull();
  });
});
