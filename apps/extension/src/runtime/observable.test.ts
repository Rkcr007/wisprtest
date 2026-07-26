import { describe, expect, it, vi } from 'vitest';

import { createStore } from './observable.js';

describe('createStore', () => {
  it('delivers the current value on subscribe, before returning', () => {
    const store = createStore(1);
    const seen: number[] = [];

    const subscription = store.observable.subscribe((value) => {
      seen.push(value);
    });

    // Synchronously, not on a microtask: a subscriber must never have to read `value` separately
    // to prime itself, because between the read and the subscribe is a window it could miss.
    expect(seen).toEqual([1]);
    subscription.unsubscribe();
  });

  it('notifies every subscriber on change and stops after unsubscribe', () => {
    const store = createStore('a');
    const first: string[] = [];
    const second: string[] = [];

    const one = store.observable.subscribe((value) => {
      first.push(value);
    });
    store.observable.subscribe((value) => {
      second.push(value);
    });

    store.set('b');
    one.unsubscribe();
    store.set('c');

    expect(first).toEqual(['a', 'b']);
    expect(second).toEqual(['a', 'b', 'c']);
    expect(store.observable.value).toBe('c');
  });

  it('does not wake subscribers for a value that has not changed', () => {
    const observer = vi.fn();
    const store = createStore({ n: 1 }, { equals: (a, b) => a.n === b.n });
    store.observable.subscribe(observer);

    store.set({ n: 1 });
    expect(observer).toHaveBeenCalledTimes(1);

    store.set({ n: 2 });
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it('reports a throwing subscriber without skipping the ones behind it', () => {
    const onError = vi.fn();
    const store = createStore(0, { onError });
    const downstream: number[] = [];

    store.observable.subscribe(() => {
      throw new Error('a rendering bug in the HUD');
    });
    store.observable.subscribe((value) => {
      downstream.push(value);
    });

    store.set(1);

    // The whole point: a HUD component with a bug must not be able to stop the scoped index
    // from being told the page changed.
    expect(downstream).toEqual([0, 1]);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('survives a subscriber that unsubscribes while being notified', () => {
    const store = createStore(0);
    const seen: number[] = [];

    // The priming call happens before `subscribe` returns, so the handle is captured on the
    // first change instead. This is React unmounting a HUD component in response to a state
    // change — the set is mutated mid-notification, and the loop must still finish.
    let self: { unsubscribe(): void } | null = null;
    self = store.observable.subscribe(() => {
      self?.unsubscribe();
    });
    store.observable.subscribe((value) => {
      seen.push(value);
    });

    expect(() => {
      store.set(1);
    }).not.toThrow();
    expect(seen).toEqual([0, 1]);

    store.set(2);
    expect(seen).toEqual([0, 1, 2]);
  });

  it('stops publishing once closed, but still primes a late subscriber', () => {
    const store = createStore('final');
    const seen: string[] = [];

    store.close();
    store.set('ignored');
    store.observable.subscribe((value) => {
      seen.push(value);
    });

    expect(seen).toEqual(['final']);
    expect(store.observable.value).toBe('final');
  });
});
