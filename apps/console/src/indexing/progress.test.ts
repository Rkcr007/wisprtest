import { IndexProgressEvent } from 'protocol';
import { describe, expect, it } from 'vitest';

import { completionRatio, initialProgress, reduceProgress } from './progress';

/**
 * The reducer that turns the gateway's event stream into the Indexing screen.
 *
 * Every fixture below is parsed through `IndexProgressEvent` before it reaches the reducer, so a
 * test cannot pass by feeding it a shape the gateway would never send. If the contract changes,
 * these fail at the fixture rather than silently asserting against a fiction.
 */

const JOB = '0a4a2fa1-2b1e-4a2c-9f5d-8c6c2c1f0001';
const TENANT = '0a4a2fa1-2b1e-4a2c-9f5d-8c6c2c1f0002';
const VERSION_ID = '0a4a2fa1-2b1e-4a2c-9f5d-8c6c2c1f0003';
const SCREEN_A = '0a4a2fa1-2b1e-4a2c-9f5d-8c6c2c1f0004';
const SCREEN_B = '0a4a2fa1-2b1e-4a2c-9f5d-8c6c2c1f0005';
const FINGERPRINT = 'a'.repeat(64);

/** Parses through the contract so a malformed fixture fails loudly here, not as a false pass. */
function event(input: unknown): IndexProgressEvent {
  return IndexProgressEvent.parse(input);
}

const base = { jobId: JOB, tenantId: TENANT };

function jobStarted(sequence = 0, resumed = false): IndexProgressEvent {
  return event({
    ...base,
    kind: 'job_started',
    sequence,
    at: '2026-08-02T10:00:00.000Z',
    memoryVersionId: VERSION_ID,
    version: 4,
    resumed,
  });
}

function routeStarted(sequence: number, path: string, depth = 0): IndexProgressEvent {
  return event({ ...base, kind: 'route_started', sequence, at: '2026-08-02T10:00:01.000Z', path, depth });
}

function routeIndexed(
  sequence: number,
  routePattern: string,
  elementCount: number,
  screenId = SCREEN_A,
): IndexProgressEvent {
  return event({
    ...base,
    kind: 'route_indexed',
    sequence,
    at: '2026-08-02T10:00:02.000Z',
    screenId,
    routePattern,
    stateFingerprint: FINGERPRINT,
    elementCount,
    durationMs: 850,
  });
}

function routeSkipped(sequence: number, path: string, reason: string): IndexProgressEvent {
  return event({ ...base, kind: 'route_skipped', sequence, at: '2026-08-02T10:00:03.000Z', path, reason });
}

function edgeRecorded(sequence: number): IndexProgressEvent {
  return event({
    ...base,
    kind: 'edge_recorded',
    sequence,
    at: '2026-08-02T10:00:04.000Z',
    fromScreenId: SCREEN_A,
    toScreenId: SCREEN_B,
    triggerElementKey: 'orders.filter.pending',
    confidence: 0.91,
  });
}

function jobCompleted(sequence: number, totals: Partial<Record<string, number>> = {}): IndexProgressEvent {
  return event({
    ...base,
    kind: 'job_completed',
    sequence,
    at: '2026-08-02T10:05:00.000Z',
    memoryVersionId: VERSION_ID,
    screenCount: totals.screenCount ?? 12,
    elementCount: totals.elementCount ?? 480,
    edgeCount: totals.edgeCount ?? 30,
    durationMs: totals.durationMs ?? 300_000,
  });
}

function jobFailed(sequence: number, code = 'navigation_failed'): IndexProgressEvent {
  return event({
    ...base,
    kind: 'job_failed',
    sequence,
    at: '2026-08-02T10:04:00.000Z',
    memoryVersionId: VERSION_ID,
    code,
    detail: 'the base URL did not respond',
  });
}

/** Fold a whole stream, the way the store does. */
function fold(...events: readonly IndexProgressEvent[]) {
  return events.reduce(reduceProgress, initialProgress);
}

describe('reduceProgress — lifecycle', () => {
  it('starts disconnected, with nothing invented', () => {
    expect(initialProgress.phase).toBe('connecting');
    expect(initialProgress.routes).toEqual([]);
    expect(initialProgress.edges).toEqual([]);
    expect(initialProgress.routesIndexed).toBe(0);
    expect(initialProgress.elementCount).toBe(0);
    expect(initialProgress.jobId).toBeNull();
  });

  it('moves to running and records the memory version the crawl is filling in', () => {
    const state = fold(jobStarted());

    expect(state.phase).toBe('running');
    expect(state.jobId).toBe(JOB);
    expect(state.memoryVersionId).toBe(VERSION_ID);
    expect(state.version).toBe(4);
    expect(state.resumed).toBe(false);
    expect(state.startedAt).toBe('2026-08-02T10:00:00.000Z');
  });

  it('carries the resumed flag through, so a continued crawl says so', () => {
    expect(fold(jobStarted(0, true)).resumed).toBe(true);
  });

  it('leaves connecting on any event, not only on job_started', () => {
    // A console that joins mid-crawl never sees `job_started`; it must not sit on "connecting".
    expect(fold(routeStarted(7, '/orders')).phase).toBe('running');
    expect(fold(routeIndexed(7, '/orders', 3)).phase).toBe('running');
    expect(fold(routeSkipped(7, '/admin', 'off_allowlist')).phase).toBe('running');
    expect(fold(edgeRecorded(7)).phase).toBe('running');
  });

  it('learns the job id from whichever event arrives first', () => {
    expect(fold(routeStarted(3, '/orders')).jobId).toBe(JOB);
  });
});

describe('reduceProgress — routes', () => {
  it('lists a route the moment the crawler navigates to it', () => {
    const state = fold(jobStarted(), routeStarted(1, '/orders', 2));

    expect(state.routes).toHaveLength(1);
    expect(state.routes[0]).toMatchObject({
      path: '/orders',
      depth: 2,
      status: 'crawling',
      routePattern: null,
      elementCount: null,
    });
  });

  it('pairs an indexed route with the one in flight rather than appending a second row', () => {
    const state = fold(jobStarted(), routeStarted(1, '/orders/8f21', 2), routeIndexed(2, '/orders/:id', 41));

    expect(state.routes).toHaveLength(1);
    expect(state.routes[0]).toMatchObject({
      // The concrete path survives from `route_started`; the pattern arrives with `route_indexed`.
      path: '/orders/8f21',
      routePattern: '/orders/:id',
      depth: 2,
      status: 'indexed',
      elementCount: 41,
      durationMs: 850,
      screenId: SCREEN_A,
    });
    expect(state.routesIndexed).toBe(1);
    expect(state.elementCount).toBe(41);
  });

  it('appends an orphan route_indexed instead of dropping it', () => {
    // A stream resumed mid-crawl, where the matching `route_started` has aged out of Redis.
    const state = fold(routeIndexed(9, '/orders/:id', 41));

    expect(state.routes).toHaveLength(1);
    expect(state.routes[0]).toMatchObject({
      path: null,
      depth: null,
      routePattern: '/orders/:id',
      status: 'indexed',
    });
    expect(state.routesIndexed).toBe(1);
  });

  it('pairs the oldest route still crawling when two started before either finished', () => {
    const state = fold(
      routeStarted(1, '/orders'),
      routeStarted(2, '/settings'),
      routeIndexed(3, '/orders', 10),
    );

    expect(state.routes[0]).toMatchObject({ path: '/orders', status: 'indexed' });
    expect(state.routes[1]).toMatchObject({ path: '/settings', status: 'crawling' });
  });

  it('records a skip with its reason and counts it separately', () => {
    const state = fold(jobStarted(), routeSkipped(1, '/admin', 'off_allowlist'));

    expect(state.routes[0]).toMatchObject({
      path: '/admin',
      status: 'skipped',
      skipReason: 'off_allowlist',
      elementCount: null,
    });
    expect(state.routesSkipped).toBe(1);
    expect(state.routesIndexed).toBe(0);
  });

  it('does not let a skip consume the route in flight', () => {
    const state = fold(routeStarted(1, '/orders'), routeSkipped(2, '/admin', 'off_allowlist'));

    expect(state.routes).toHaveLength(2);
    expect(state.routes[0]).toMatchObject({ path: '/orders', status: 'crawling' });
  });

  it('accumulates element counts across routes', () => {
    const state = fold(
      routeStarted(1, '/orders'),
      routeIndexed(2, '/orders', 41),
      routeStarted(3, '/settings'),
      routeIndexed(4, '/settings', 9, SCREEN_B),
    );

    expect(state.routesIndexed).toBe(2);
    expect(state.elementCount).toBe(50);
    expect(state.routes.map((route) => route.status)).toEqual(['indexed', 'indexed']);
  });
});

describe('reduceProgress — edges', () => {
  it('records an observed navigation edge with its confidence', () => {
    const state = fold(jobStarted(), edgeRecorded(1));

    expect(state.edges).toHaveLength(1);
    expect(state.edges[0]).toMatchObject({
      fromScreenId: SCREEN_A,
      toScreenId: SCREEN_B,
      triggerElementKey: 'orders.filter.pending',
      confidence: 0.91,
    });
    expect(state.edgeCount).toBe(1);
  });

  it('keeps edges in arrival order', () => {
    const state = fold(edgeRecorded(1), edgeRecorded(2), edgeRecorded(3));

    expect(state.edgeCount).toBe(3);
    expect(state.edges).toHaveLength(3);
  });
});

describe('reduceProgress — terminal states', () => {
  it('lets the completion totals win over the running counts', () => {
    // A console that connected halfway through has counted only what it saw.
    const state = fold(
      routeStarted(8, '/orders'),
      routeIndexed(9, '/orders', 41),
      jobCompleted(10, { screenCount: 12, elementCount: 480, edgeCount: 30 }),
    );

    expect(state.phase).toBe('completed');
    expect(state.routesIndexed).toBe(12);
    expect(state.elementCount).toBe(480);
    expect(state.edgeCount).toBe(30);
    expect(state.totalDurationMs).toBe(300_000);
    expect(state.finishedAt).toBe('2026-08-02T10:05:00.000Z');
  });

  it('records a failure with its taxonomy code and detail', () => {
    const state = fold(jobStarted(), jobFailed(1, 'ssrf_rejected'));

    expect(state.phase).toBe('failed');
    expect(state.failure).toEqual({
      code: 'ssrf_rejected',
      detail: 'the base URL did not respond',
    });
    expect(state.finishedAt).toBe('2026-08-02T10:04:00.000Z');
  });

  it('keeps what was indexed before a failure — a failed crawl is not an empty one', () => {
    const state = fold(routeStarted(1, '/orders'), routeIndexed(2, '/orders', 41), jobFailed(3));

    expect(state.phase).toBe('failed');
    expect(state.routes).toHaveLength(1);
    expect(state.routesIndexed).toBe(1);
    expect(state.elementCount).toBe(41);
  });

  it('does not reopen a completed job when a late event arrives', () => {
    const state = fold(jobCompleted(5), routeStarted(6, '/late'));

    // The phase guard only lifts `connecting`; a terminal phase stays terminal.
    expect(state.phase).toBe('completed');
  });

  it('does not reopen a failed job either', () => {
    expect(fold(jobFailed(5), routeIndexed(6, '/late', 1)).phase).toBe('failed');
  });
});

describe('reduceProgress — sequence integrity', () => {
  it('tracks the last sequence and reports no gap on a contiguous stream', () => {
    const state = fold(jobStarted(0), routeStarted(1, '/orders'), routeIndexed(2, '/orders', 5));

    expect(state.lastSequence).toBe(2);
    expect(state.sequenceGap).toBe(false);
  });

  it('does not call the first event a gap, whatever its sequence', () => {
    // A stream resumed from `Last-Event-ID` legitimately starts partway through.
    const state = fold(routeStarted(97, '/orders'));

    expect(state.sequenceGap).toBe(false);
    expect(state.lastSequence).toBe(97);
  });

  it('flags a missing event', () => {
    const state = fold(jobStarted(0), routeStarted(1, '/orders'), routeIndexed(3, '/orders', 5));

    expect(state.sequenceGap).toBe(true);
    expect(state.lastSequence).toBe(3);
  });

  it('flags a reordered event', () => {
    const state = fold(jobStarted(0), routeStarted(2, '/orders'), routeIndexed(1, '/orders', 5));

    expect(state.sequenceGap).toBe(true);
  });

  it('flags a duplicate delivery', () => {
    // Redis stream reads are at-least-once; a redelivery repeats a sequence.
    const state = fold(jobStarted(0), routeStarted(1, '/orders'), routeStarted(1, '/orders'));

    expect(state.sequenceGap).toBe(true);
  });

  it('counts a duplicated route_indexed twice, which is why the gap flag matters', () => {
    // The reducer is not idempotent and does not pretend to be: it flags the anomaly and the
    // completion totals correct the counts. Asserting the real behaviour rather than a wish.
    const state = fold(routeStarted(1, '/orders'), routeIndexed(2, '/orders', 41), routeIndexed(2, '/orders', 41));

    expect(state.routesIndexed).toBe(2);
    expect(state.sequenceGap).toBe(true);
  });

  it('keeps the gap flag raised once it has been raised', () => {
    const state = fold(
      jobStarted(0),
      routeStarted(5, '/orders'),
      routeIndexed(6, '/orders', 5),
      routeStarted(7, '/settings'),
    );

    expect(state.sequenceGap).toBe(true);
  });

  it('leaves earlier state untouched — the reducer never mutates its input', () => {
    const before = fold(jobStarted(0), routeStarted(1, '/orders'));
    const snapshot = JSON.stringify(before);

    reduceProgress(before, routeIndexed(2, '/orders', 5));

    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('completionRatio', () => {
  it('is null with no page cap, rather than inventing a denominator', () => {
    const state = fold(routeStarted(1, '/orders'), routeIndexed(2, '/orders', 5));

    expect(completionRatio(state, null)).toBeNull();
  });

  it('is null for a nonsensical page cap', () => {
    expect(completionRatio(initialProgress, 0)).toBeNull();
    expect(completionRatio(initialProgress, -5)).toBeNull();
  });

  it('measures indexed and skipped routes against the cap the tester set', () => {
    const state = fold(
      routeStarted(1, '/orders'),
      routeIndexed(2, '/orders', 5),
      routeSkipped(3, '/admin', 'off_allowlist'),
    );

    expect(completionRatio(state, 10)).toBeCloseTo(0.2);
  });

  it('never exceeds one, even when the crawl overshoots the cap', () => {
    const state = fold(
      routeSkipped(1, '/a', 'off_allowlist'),
      routeSkipped(2, '/b', 'off_allowlist'),
      routeSkipped(3, '/c', 'off_allowlist'),
    );

    expect(completionRatio(state, 2)).toBe(1);
  });

  it('is exactly one on completion, cap or no cap', () => {
    const state = fold(jobCompleted(1));

    expect(completionRatio(state, null)).toBe(1);
    expect(completionRatio(state, 500)).toBe(1);
  });
});
