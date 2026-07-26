/**
 * The observable the runtime state is published through.
 *
 * Phase 7's requirement is "expose the state as an observable other modules subscribe to. No
 * global mutable state." Both halves are load-bearing, and a hand-rolled fifty lines is what
 * satisfies them without adding a reactive library to a bundle that is injected into every page
 * a tester visits.
 *
 * ## Why not an EventTarget
 *
 * `EventTarget` is available and would be free. It carries values as `CustomEvent.detail`, which
 * is `any`-shaped, and it has no notion of a current value — a module that subscribes after the
 * page has settled would see nothing until the next change. Both matter here: the state is a
 * typed record, and the resolver subscribing mid-session must be told where things stand rather
 * than sit blind until the tester scrolls.
 *
 * ## The design, in three rules
 *
 * 1. **A store, not a stream.** Every store has a current value; subscribing delivers it
 *    synchronously before returning.
 * 2. **A subscriber's throw cannot break the engine.** Observers are called inside a `try`, and a
 *    failure is reported to the store's `onError` rather than aborting the notification of the
 *    subscribers that come after it. A HUD component with a rendering bug must not stop the
 *    scoped index from updating.
 * 3. **Nothing is module-scoped.** Every store is created by a call and owned by its creator, so
 *    two engines in one page — which is what a test file does — cannot see each other's state.
 */

export interface Subscription {
  unsubscribe(): void;
}

export type Observer<T> = (value: T) => void;

/** A value that changes over time, and can be read at any instant. */
export interface Observable<T> {
  /** The current value. Always defined: a store is created with one. */
  readonly value: T;

  /**
   * Observe every change, starting with the current value.
   *
   * The observer is called synchronously once before this returns, so a subscriber never has to
   * read `value` separately to prime itself and never has a window in which it could miss a
   * change between the read and the subscribe.
   */
  subscribe(observer: Observer<T>): Subscription;
}

/** A store, plus the one handle that can change it. Kept apart so a consumer cannot write. */
export interface Store<T> {
  readonly observable: Observable<T>;
  /** Publish a new value. A no-op when `equals` says it has not changed. */
  set(value: T): void;
  /** Drop every observer. Called when the engine that owns the store is disposed. */
  close(): void;
}

export interface StoreOptions<T> {
  /**
   * When two values count as the same, so subscribers are not woken for nothing.
   *
   * Defaults to `Object.is`. The state engine supplies a structural comparison, because it
   * rebuilds its state record on every mutation burst and most bursts change nothing an observer
   * cares about — a table repainting its rows does not move the state fingerprint.
   */
  readonly equals?: (a: T, b: T) => boolean;

  /**
   * Where a throwing observer is reported. Defaults to rethrowing asynchronously, so the failure
   * reaches the console and the error reporter without unwinding the caller.
   */
  readonly onError?: (error: unknown) => void;
}

function rethrowAsync(error: unknown): void {
  setTimeout(() => {
    throw error;
  }, 0);
}

export function createStore<T>(initial: T, options: StoreOptions<T> = {}): Store<T> {
  const equals = options.equals ?? Object.is;
  const onError = options.onError ?? rethrowAsync;

  let current = initial;
  let closed = false;
  const observers = new Set<Observer<T>>();

  const emit = (observer: Observer<T>, value: T): void => {
    try {
      observer(value);
    } catch (error) {
      onError(error);
    }
  };

  const observable: Observable<T> = {
    get value(): T {
      return current;
    },

    subscribe(observer: Observer<T>): Subscription {
      if (closed) {
        // Still deliver the final value: a late subscriber wants to know where things ended up,
        // and silently handing back a dead subscription would look like a hang.
        emit(observer, current);
        return { unsubscribe: () => undefined };
      }

      observers.add(observer);
      emit(observer, current);

      return {
        unsubscribe: () => {
          observers.delete(observer);
        },
      };
    },
  };

  return {
    observable,

    set(value: T): void {
      if (closed || equals(current, value)) return;
      current = value;

      // Iterated over a copy. An observer that unsubscribes — or subscribes — while being
      // notified would otherwise mutate the set mid-iteration, and the HUD does exactly that
      // when React unmounts a component in response to a state change.
      for (const observer of [...observers]) {
        emit(observer, value);
      }
    },

    close(): void {
      closed = true;
      observers.clear();
    },
  };
}
