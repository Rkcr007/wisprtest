/**
 * The runtime state engine — `Remember → Execute`'s "where are we now".
 *
 * Everything the resolver needs to know about the page it is resolving against, derived from
 * observable streams and published as one value. Nothing here polls, nothing here is
 * module-scoped, and nothing here crosses the network (CLAUDE.md rule #2).
 *
 * ```ts
 * const engine = createRuntimeStateEngine({ window, ignoreFocus: (el) => el.localName === HOST_TAG });
 *
 * engine.state.subscribe((state) => {
 *   // state.stateFingerprint is the cache key for scoped resolution and the drift key.
 * });
 *
 * engine.scopedIndex.candidates(); // visible ∩ reachable — the only set resolution may search
 * ```
 *
 * Two things live in `packages/fingerprint` rather than here, and deliberately: the state
 * fingerprint and the definition of an interactive candidate. The Playwright indexer computes
 * both when it records a screen, and if the two implementations ever disagreed the runtime would
 * simply never find anything memory holds — silently, on every command. See CLAUDE.md rule #4.
 */

export { createFocusTracker } from './focus.js';
export type { FocusTracker, FocusTrackerOptions } from './focus.js';
export {
  createMutationStream,
  DEFAULT_DEBOUNCE_MS,
  globalScheduler,
  WATCHED_ATTRIBUTES,
} from './mutations.js';
export type {
  MutationBurst,
  MutationStream,
  MutationStreamOptions,
  Scheduler,
} from './mutations.js';
export { createStore } from './observable.js';
export type { Observable, Observer, Store, StoreOptions, Subscription } from './observable.js';
export { createRouteSource } from './route.js';
export type { RouteSource, RouteSourceOptions } from './route.js';
export { installRouteBridge, INSTALLED_ATTRIBUTE, ROUTE_EVENT } from './route-bridge.js';
export type { RuntimeWindow } from './route-bridge.js';
export { createScopedElementIndex } from './scoped-index.js';
export type { ScopedElementIndex, ScopedElementIndexOptions } from './scoped-index.js';
export { createRuntimeStateEngine, toRuntimeState } from './state-engine.js';
export type {
  LiveRuntimeState,
  RuntimeStateEngine,
  RuntimeStateEngineOptions,
} from './state-engine.js';
export { createVisibilityTracker } from './visibility.js';
export type { VisibilityTracker, VisibilityTrackerOptions } from './visibility.js';
