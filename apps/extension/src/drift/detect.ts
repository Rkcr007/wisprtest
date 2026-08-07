import type { MemorySnapshot } from 'protocol';

import type { LiveRuntimeState } from '../runtime/state-engine.js';

/**
 * Drift detection, in the extension.
 *
 * docs/ARCHITECTURE.md § 6's learning loop begins here: `structural hash mismatch → drift report`.
 * The RuntimeStateEngine already recomputes the structural hash on route settle (`state-engine.ts`,
 * "Why the structural hash is not recomputed per burst"), so this module adds no walk of its own —
 * it compares the hash the engine published against the one memory holds for the same screen.
 *
 * ## Detection never blocks anything
 *
 * `BUILD-PLAN.md` Phase 17 is explicit: "show a NON-BLOCKING notice, and continue working in
 * degraded mode. Never block the tester." So this is a pure function returning a value. It performs
 * no I/O, awaits nothing, and cannot fail — the caller decides what to do with an observation, and
 * everything downstream of it is fire-and-forget.
 *
 * ## What is *not* drift
 *
 * Three cases return null, and each of them would be a false report that costs a human's attention:
 *
 * 1. **A screen memory has never seen.** No `ScreenNode` carries this state fingerprint. That is an
 *    unindexed screen, not a changed one — the crawl's bounds may simply not have reached it. It
 *    also could not be reported if we wanted to: `DriftRaiseRequest` requires a `screenId`, and
 *    inventing one would propose a diff against a screen that does not exist.
 * 2. **A hash that describes nothing.** The engine primes `structuralHash` before the mutation
 *    streams attach and recomputes it only once a route has settled, so there is a window during
 *    navigation where the published hash belongs to a page that is half-built. An empty hash is
 *    that window, and reporting from inside it would say the whole screen changed.
 * 3. **Agreement.** The ordinary case, and the one this runs on almost every settle.
 */

/**
 * A structural mismatch, in the form the raise request needs.
 *
 * Deliberately not a `DriftRaiseRequest`: that carries a `sessionId`, which is the service worker's
 * to supply and which the content script has no business holding — the same division `seed-client.ts`
 * draws and for the same reason. This is everything the page side alone can know.
 */
export interface DriftObservation {
  /** The screen whose stored hash no longer matches, as named by the snapshot. */
  readonly screenId: string;
  readonly routePattern: string;
  /** The concrete path the tester was on. What a reconcile navigates to. */
  readonly route: string;
  readonly stateFingerprint: string;
  readonly expectedStructuralHash: string;
  readonly observedStructuralHash: string;
  readonly observedAt: string;
}

export interface DriftDetector {
  /**
   * Compare one published state against memory. Null when the screen still matches, is unknown, or
   * has not settled.
   */
  detect(live: LiveRuntimeState): DriftObservation | null;
}

/**
 * Whether a path is somewhere a reconcile could actually navigate.
 *
 * Mirrors `isVisitablePath` in `packages/protocol/src/drift.ts`, which refines both
 * `DriftRaiseRequest.route` and `DriftReconcileJob.route`. A live route comes from `location`, so it
 * is concrete by construction and this all but always passes — but RFC 3986 does permit `:` inside
 * a path segment, and an application that uses one would otherwise produce a report the gateway
 * rejects with a validation error nobody is watching for. Cheaper to notice here and stay quiet.
 *
 * Checked per segment rather than by searching for a colon, for the reason the protocol gives: only
 * a segment that *begins* with one is a pattern placeholder.
 */
function isVisitablePath(route: string): boolean {
  return !route.split('/').some((segment) => segment.startsWith(':'));
}

/**
 * Index a snapshot's screens by state fingerprint, once.
 *
 * The same key `resolver.ts` scopes by, and the same identity `ScreenNode` documents: "A screen is
 * not a URL. `/orders/:id` with a confirmation dialog open is a different screen from `/orders/:id`
 * without one." Built once per snapshot rather than per settle — a settle happens on every
 * navigation, and rebuilding a map of every screen each time would put a linear scan on a path that
 * runs while the tester is moving around the application.
 *
 * A memory version holds one screen per fingerprint. If a malformed snapshot ever carried two, the
 * first wins and the second is ignored, which is stable rather than order-dependent-looking.
 */
export function createDriftDetector(snapshot: MemorySnapshot): DriftDetector {
  const byStateFingerprint = new Map<string, MemorySnapshot['screens'][number]>();
  for (const screen of snapshot.screens) {
    if (!byStateFingerprint.has(screen.stateFingerprint)) {
      byStateFingerprint.set(screen.stateFingerprint, screen);
    }
  }

  return {
    detect(live: LiveRuntimeState): DriftObservation | null {
      // Case 2: the engine has not settled on a hash worth comparing.
      if (live.structuralHash === '') return null;

      // Case 1: a screen the crawl never reached. Unindexed, not drifted.
      const screen = byStateFingerprint.get(live.stateFingerprint);
      if (screen === undefined) return null;

      // Case 3, and the overwhelmingly common one.
      if (screen.structuralHash === live.structuralHash) return null;

      if (!isVisitablePath(live.route)) return null;

      return {
        screenId: screen.id,
        routePattern: screen.routePattern,
        route: live.route,
        stateFingerprint: live.stateFingerprint,
        expectedStructuralHash: screen.structuralHash,
        observedStructuralHash: live.structuralHash,
        observedAt: live.capturedAt,
      };
    },
  };
}
