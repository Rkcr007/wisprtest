import {
  computeStateFingerprint,
  DEFAULT_CONFIG,
  defaultRedactor,
  readModalStack,
  structuralHash,
  toRoutePattern,
  topmostDialog,
} from 'fingerprint';
import type { FingerprintConfig, Redactor } from 'fingerprint';
import type { ElementKey, RuntimeState } from 'protocol';

import { createFocusTracker, type FocusTracker } from './focus.js';
import { createMutationStream, type MutationStream, type Scheduler } from './mutations.js';
import { createStore, type Observable } from './observable.js';
import { createRouteSource, type RouteSource } from './route.js';
import type { RuntimeWindow } from './route-bridge.js';
import { createScopedElementIndex, type ScopedElementIndex } from './scoped-index.js';
import { createVisibilityTracker, type VisibilityTracker } from './visibility.js';

/**
 * The RuntimeStateEngine, per docs/ARCHITECTURE.md § 3.
 *
 * It derives a state vector from four observable streams and publishes it. It does not poll, and
 * it owns no module-level state: everything below is created by a call and disposed by its
 * owner, so two engines in one page cannot see each other.
 *
 * | Output | Source |
 * |---|---|
 * | `route` | History API interception — `route.ts`, `route-bridge.ts` |
 * | `routePattern` | `toRoutePattern`, shared with the indexer |
 * | `modalStack` | `dialog[open]` / `[role=dialog]` / `[aria-modal]`, re-read per mutation burst |
 * | `focusedLandmark` | `focusin` / `focusout` — `focus.ts` |
 * | `visibleSet` | `IntersectionObserver` — `visibility.ts` |
 * | `structuralHash` | recomputed on route settle |
 * | `stateFingerprint` | `hash(routePattern, modalStack, focusedLandmark)` |
 *
 * ## Why the structural hash is not recomputed per burst
 *
 * It is a walk of the entire subtree. docs/ARCHITECTURE.md § 3 specifies it as "computed on route
 * settle", and that is exactly what happens here: when the route pattern has changed and the
 * mutation stream then goes quiet for one debounce window, it is recomputed once. A page that
 * never stops mutating never settles and so never pays for it — which is the right trade, since a
 * hash of a subtree that is still changing describes nothing.
 *
 * Structural change *within* a route is real, and detecting it is Phase 17's drift loop. This
 * phase does not pre-empt it.
 *
 * ## Every input is injectable
 *
 * The timers, the two observer constructors and the clock are all parameters. That is not
 * generality for its own sake: happy-dom implements `IntersectionObserver` but has no layout
 * engine, so it never fires, and a test that had to await real observer callbacks and real 50 ms
 * windows would be a slow test that flakes. With them injected, `state-engine.test.ts` drives
 * every stream directly and asserts on exact state transitions.
 */

/**
 * The state vector, in the form it takes inside the process.
 *
 * `visibleSet` holds live `Element`s, matching docs/ARCHITECTURE.md § 3. The protocol's
 * `RuntimeState` carries element *keys* instead, because DOM nodes do not cross a process
 * boundary and keys come from memory; {@link toRuntimeState} projects one to the other once
 * Phase 8's memory snapshot can supply them.
 *
 * Every field is a value, and a new record is published rather than mutated, so a subscriber can
 * hold one and compare it against the next.
 */
export interface LiveRuntimeState {
  /** Absolute path, normalised: no origin, no query, no fragment, no trailing slash. */
  readonly route: string;
  /** The same path with identifiers generalised, e.g. `/orders/:id`. */
  readonly routePattern: string;
  /** Redacted labels of open dialogs, outermost first. */
  readonly modalStack: readonly string[];
  /** The landmark holding focus, or null when focus is on the body or nowhere. */
  readonly focusedLandmark: string | null;
  /** Elements currently intersecting the viewport. A snapshot, not the live set. */
  readonly visibleSet: ReadonlySet<Element>;
  readonly structuralHash: string;
  readonly stateFingerprint: string;
  readonly capturedAt: string;
}

export interface RuntimeStateEngine {
  /** The state, as an observable. Subscribing delivers the current value synchronously. */
  readonly state: Observable<LiveRuntimeState>;

  /** The candidate set the resolver searches. Kept in step with the state by this engine. */
  readonly scopedIndex: ScopedElementIndex;

  /**
   * Drain any queued mutations and republish, synchronously.
   *
   * `MutationObserver` delivers on a microtask, so code that has just changed the DOM itself —
   * the action executor, from Phase 10 — would otherwise read a state one turn stale.
   */
  flush(): void;

  dispose(): void;
}

export interface RuntimeStateEngineOptions {
  /** The window to observe. The content script passes its own. */
  readonly window: RuntimeWindow;

  /** The subtree to index and hash. Defaults to the document's `body`. */
  readonly root?: Element;

  /**
   * Focus targets to disregard — the HUD's shadow host.
   *
   * See `focus.ts`: without it, every time the tester touched the panel the state fingerprint
   * would move, invalidating the scoped resolution cache and reading as drift.
   */
  readonly ignoreFocus?: (element: Element) => boolean;

  /** Coalescing window for the mutation stream. Defaults to 50 ms. */
  readonly debounceMs?: number;
  readonly scheduler?: Scheduler;
  readonly mutationObserverFactory?: (callback: MutationCallback) => MutationObserver;
  readonly intersectionObserverFactory?: (
    callback: IntersectionObserverCallback,
  ) => IntersectionObserver;

  /** Clock for `capturedAt`. Defaults to the system clock. */
  readonly now?: () => Date;

  readonly config?: FingerprintConfig;
  readonly redact?: Redactor;

  /** Where a throwing subscriber is reported. Defaults to an asynchronous rethrow. */
  readonly onError?: (error: unknown) => void;
}

export function createRuntimeStateEngine(options: RuntimeStateEngineOptions): RuntimeStateEngine {
  const { window } = options;
  const { document } = window;
  const root = options.root ?? document.body;
  const config = options.config ?? DEFAULT_CONFIG;
  const redact = options.redact ?? defaultRedactor;
  const now = options.now ?? ((): Date => new Date());

  let route = '';
  let routePattern = '';
  let modalStack: readonly string[] = [];
  let focusedLandmark = '';
  let hash = '';
  /** The route pattern the current `hash` was computed for. Drives the settle recomputation. */
  let hashedRoutePattern: string | null = null;

  let disposed = false;

  const visibility: VisibilityTracker = createVisibilityTracker({
    onChange: () => {
      scopedIndex.invalidateVisibility();
      publish();
    },
    ...(options.intersectionObserverFactory === undefined
      ? {}
      : { observerFactory: options.intersectionObserverFactory }),
  });

  const scopedIndex: ScopedElementIndex = createScopedElementIndex({ root, visibility });

  const routeSource: RouteSource = createRouteSource(window, {
    onChange: (next) => {
      route = next;
      routePattern = toRoutePattern(next);
      publish();
    },
  });

  const focus: FocusTracker = createFocusTracker(document, {
    onChange: (landmark) => {
      focusedLandmark = landmark;
      publish();
    },
    config,
    redact,
    ...(options.ignoreFocus === undefined ? {} : { ignore: options.ignoreFocus }),
  });

  const mutations: MutationStream = createMutationStream({
    onBurst: (burst) => {
      // The location first: an SPA that pushed a route and re-rendered in one turn should not
      // have the new elements attributed to the old route's state fingerprint.
      routeSource.poke();

      modalStack = readModalStack(document, redact);
      // Before the mutations, so anything registered from this burst is scoped correctly as it
      // is registered rather than needing a second pass.
      scopedIndex.setScopeRoot(topmostDialog(document));
      scopedIndex.applyMutations(burst.records);

      publish();
    },

    onSettle: () => {
      if (routePattern === hashedRoutePattern) return;
      hash = structuralHash(root, config);
      hashedRoutePattern = routePattern;
      publish();
    },

    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.mutationObserverFactory === undefined
      ? {}
      : { observerFactory: options.mutationObserverFactory }),
  });

  function snapshot(): LiveRuntimeState {
    return {
      route,
      routePattern,
      modalStack,
      focusedLandmark: focusedLandmark === '' ? null : focusedLandmark,
      // Copied, so a published state stays what it was when it was published. The tracker's set
      // is live and would otherwise change under a subscriber holding an older record.
      visibleSet: new Set(visibility.visible),
      structuralHash: hash,
      stateFingerprint: computeStateFingerprint(routePattern, modalStack, focusedLandmark),
      capturedAt: now().toISOString(),
    };
  }

  function publish(): void {
    if (disposed) return;
    store.set(snapshot());
  }

  // Primed before the streams are attached, so a subscriber that arrives before the first
  // mutation still sees the real page rather than an empty placeholder.
  route = routeSource.path;
  routePattern = toRoutePattern(route);
  modalStack = readModalStack(document, redact);
  focusedLandmark = focus.landmark;
  hash = structuralHash(root, config);
  hashedRoutePattern = routePattern;
  scopedIndex.setScopeRoot(topmostDialog(document));

  const store = createStore<LiveRuntimeState>(snapshot(), {
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  mutations.observe(document.documentElement);

  return {
    state: store.observable,
    scopedIndex,

    flush(): void {
      mutations.flush();
    },

    dispose(): void {
      disposed = true;
      mutations.dispose();
      focus.dispose();
      routeSource.dispose();
      scopedIndex.dispose();
      visibility.dispose();
      store.close();
    },
  };
}

/**
 * Project the in-process state onto the protocol's wire form.
 *
 * The caller supplies the element keys, because a live `Element` does not carry one — keys live
 * in memory, and pairing the two is the memory client's job in Phase 8. Keeping that a parameter
 * is what lets this phase produce a contract-valid `RuntimeState` without inventing an identity
 * for elements it has no way to identify.
 */
export function toRuntimeState(
  live: LiveRuntimeState,
  visibleElementKeys: readonly ElementKey[],
): RuntimeState {
  return {
    route: live.route,
    routePattern: live.routePattern,
    modalStack: [...live.modalStack],
    focusedLandmark: live.focusedLandmark,
    visibleElementKeys: [...visibleElementKeys],
    structuralHash: live.structuralHash,
    stateFingerprint: live.stateFingerprint,
    capturedAt: live.capturedAt,
  };
}
