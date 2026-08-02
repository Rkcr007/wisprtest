import type { CrawlSkipReason, IndexFailureCode, IndexProgressEvent } from 'protocol';

/**
 * The Indexing screen's view of a crawl, folded from the gateway's event stream.
 *
 * A pure reducer, deliberately: this is the one piece of the screen with real logic in it — the
 * pairing of `route_started` with `route_indexed`, the sequence-gap check, the terminal states —
 * and all of it is testable without a browser, a network or a running indexer.
 *
 * ## What the contract does and does not carry
 *
 * `IndexProgressEvent` (packages/protocol/src/indexing.ts) emits routes, navigation edges and the
 * job's own lifecycle. It emits nothing about entity schemas: `apps/indexer/src/job-runner.ts`
 * consolidates those *after* the crawl and writes them to Postgres, logging rather than
 * publishing. So this screen shows routes and edges as they are discovered, and does not show
 * schemas — inventing a schema counter the indexer never sends would be a number that is always
 * zero and looks like a bug in the indexer.
 */

export type IndexPhase =
  /** The `EventSource` has not connected yet. */
  | 'connecting'
  /** Connected, and the job is running. */
  | 'running'
  /** `job_completed`. Terminal. */
  | 'completed'
  /** `job_failed`. Terminal. */
  | 'failed'
  /** The stream itself broke — the gateway's named `error` frame, or a dead connection. */
  | 'stream_error';

export interface RouteRow {
  /** The concrete path the crawler navigated to, when the event named one. */
  readonly path: string | null;
  /** The pattern the screen was stored under. Only known once the route is indexed. */
  readonly routePattern: string | null;
  readonly depth: number | null;
  readonly status: 'crawling' | 'indexed' | 'skipped';
  readonly elementCount: number | null;
  readonly durationMs: number | null;
  readonly skipReason: CrawlSkipReason | null;
  readonly screenId: string | null;
  readonly at: string;
}

export interface EdgeRow {
  readonly fromScreenId: string;
  readonly toScreenId: string;
  readonly triggerElementKey: string;
  readonly confidence: number;
  readonly at: string;
}

export interface IndexProgressState {
  readonly phase: IndexPhase;
  readonly jobId: string | null;
  readonly memoryVersionId: string | null;
  readonly version: number | null;
  readonly resumed: boolean;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** Routes in discovery order, newest last. */
  readonly routes: readonly RouteRow[];
  readonly edges: readonly EdgeRow[];
  readonly routesIndexed: number;
  readonly routesSkipped: number;
  readonly elementCount: number;
  readonly edgeCount: number;
  /** Totals reported by `job_completed`, which are authoritative over the running counts. */
  readonly totalDurationMs: number | null;
  readonly failure: { readonly code: IndexFailureCode; readonly detail: string } | null;
  /** Set when a `sequence` arrives that is not the next one — an event was lost or reordered. */
  readonly sequenceGap: boolean;
  readonly lastSequence: number | null;
}

export const initialProgress: IndexProgressState = {
  phase: 'connecting',
  jobId: null,
  memoryVersionId: null,
  version: null,
  resumed: false,
  startedAt: null,
  finishedAt: null,
  routes: [],
  edges: [],
  routesIndexed: 0,
  routesSkipped: 0,
  elementCount: 0,
  edgeCount: 0,
  totalDurationMs: null,
  failure: null,
  sequenceGap: false,
  lastSequence: null,
};

/**
 * Fold one event into the state.
 *
 * ## Pairing a started route with an indexed one
 *
 * `route_started` carries the concrete path; `route_indexed` carries the route *pattern* and a
 * screen id, and nothing that ties it back to the path — `/orders/8f21` and `/orders/:id` cannot
 * be matched by string. They are paired positionally instead: the oldest route still marked
 * `crawling` is the one that just finished. That is sound because the indexer crawls one route at
 * a time — `createHandlers` in `apps/indexer/src/job-runner.ts` keeps a single `routeStartedAt`
 * for the whole crawl, so there is never more than one route in flight.
 *
 * A `route_indexed` with nothing in flight (a stream resumed mid-crawl, where the matching
 * `route_started` has aged out of Redis) appends its own row rather than being dropped.
 */
export function reduceProgress(
  state: IndexProgressState,
  event: IndexProgressEvent,
): IndexProgressState {
  const sequenced: Pick<IndexProgressState, 'lastSequence' | 'sequenceGap'> = {
    lastSequence: event.sequence,
    sequenceGap:
      state.sequenceGap ||
      (state.lastSequence !== null && event.sequence !== state.lastSequence + 1),
  };

  switch (event.kind) {
    case 'job_started':
      return {
        ...state,
        ...sequenced,
        phase: 'running',
        jobId: event.jobId,
        memoryVersionId: event.memoryVersionId,
        version: event.version,
        resumed: event.resumed,
        startedAt: event.at,
      };

    case 'route_started':
      return {
        ...state,
        ...sequenced,
        phase: state.phase === 'connecting' ? 'running' : state.phase,
        jobId: state.jobId ?? event.jobId,
        routes: [
          ...state.routes,
          {
            path: event.path,
            routePattern: null,
            depth: event.depth,
            status: 'crawling',
            elementCount: null,
            durationMs: null,
            skipReason: null,
            screenId: null,
            at: event.at,
          },
        ],
      };

    case 'route_indexed': {
      const inFlight = state.routes.findIndex((route) => route.status === 'crawling');
      const indexed: RouteRow = {
        path: inFlight === -1 ? null : (state.routes[inFlight]?.path ?? null),
        routePattern: event.routePattern,
        depth: inFlight === -1 ? null : (state.routes[inFlight]?.depth ?? null),
        status: 'indexed',
        elementCount: event.elementCount,
        durationMs: event.durationMs,
        skipReason: null,
        screenId: event.screenId,
        at: event.at,
      };

      return {
        ...state,
        ...sequenced,
        phase: state.phase === 'connecting' ? 'running' : state.phase,
        jobId: state.jobId ?? event.jobId,
        routes:
          inFlight === -1
            ? [...state.routes, indexed]
            : state.routes.map((route, index) => (index === inFlight ? indexed : route)),
        routesIndexed: state.routesIndexed + 1,
        elementCount: state.elementCount + event.elementCount,
      };
    }

    case 'route_skipped':
      return {
        ...state,
        ...sequenced,
        phase: state.phase === 'connecting' ? 'running' : state.phase,
        jobId: state.jobId ?? event.jobId,
        routes: [
          ...state.routes,
          {
            path: event.path,
            routePattern: null,
            depth: null,
            status: 'skipped',
            elementCount: null,
            durationMs: null,
            skipReason: event.reason,
            screenId: null,
            at: event.at,
          },
        ],
        routesSkipped: state.routesSkipped + 1,
      };

    case 'edge_recorded':
      return {
        ...state,
        ...sequenced,
        phase: state.phase === 'connecting' ? 'running' : state.phase,
        jobId: state.jobId ?? event.jobId,
        edges: [
          ...state.edges,
          {
            fromScreenId: event.fromScreenId,
            toScreenId: event.toScreenId,
            triggerElementKey: event.triggerElementKey,
            confidence: event.confidence,
            at: event.at,
          },
        ],
        edgeCount: state.edgeCount + 1,
      };

    case 'job_completed':
      return {
        ...state,
        ...sequenced,
        phase: 'completed',
        jobId: state.jobId ?? event.jobId,
        memoryVersionId: event.memoryVersionId,
        finishedAt: event.at,
        // The job's own totals win over the running counts: a console that connected halfway
        // through has counted only what it saw, and the completion event knows the whole crawl.
        routesIndexed: event.screenCount,
        elementCount: event.elementCount,
        edgeCount: event.edgeCount,
        totalDurationMs: event.durationMs,
      };

    case 'job_failed':
      return {
        ...state,
        ...sequenced,
        phase: 'failed',
        jobId: state.jobId ?? event.jobId,
        memoryVersionId: event.memoryVersionId,
        finishedAt: event.at,
        failure: { code: event.code, detail: event.detail },
      };
  }
}

/**
 * Fraction of the page cap consumed, or null when there is no honest denominator.
 *
 * A crawl's total is not knowable in advance — the crawler discovers routes as it goes — so the
 * only real bound is the page cap the tester set. When the Connect screen started this crawl it
 * carries that cap in the URL, and the bar is determinate against it. Arriving at the screen
 * without it (a shared link, a reload of an older URL) leaves the bar indeterminate rather than
 * inventing a denominator: a progress bar that is lying is worse than no progress bar.
 */
export function completionRatio(state: IndexProgressState, pageCap: number | null): number | null {
  if (state.phase === 'completed') return 1;
  if (pageCap === null || pageCap <= 0) return null;
  return Math.min(1, (state.routesIndexed + state.routesSkipped) / pageCap);
}
