import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { consoleCss } from '../styles';
import { IndexingLive } from './indexing-live';

/**
 * Indexing, rendered against a fake `EventSource`.
 *
 * The transport is stubbed at the global rather than the module, so the real
 * `subscribeToProgress` → reducer → store → render path is what runs. The assertions are about
 * what a tester can perceive: that waiting looks like the thing that is coming rather than a
 * spinner, that a determinate bar is shown only when there is an honest denominator for it, and
 * that a failure is announced instead of merely being drawn in red.
 */

const APPLICATION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const JOB = '0a4a2fa1-2b1e-4a2c-9f5d-8c6c2c1f0001';
const TENANT = '0a4a2fa1-2b1e-4a2c-9f5d-8c6c2c1f0002';
const VERSION_ID = '0a4a2fa1-2b1e-4a2c-9f5d-8c6c2c1f0003';
const SCREEN_A = '0a4a2fa1-2b1e-4a2c-9f5d-8c6c2c1f0004';
const SCREEN_B = '0a4a2fa1-2b1e-4a2c-9f5d-8c6c2c1f0005';

class FakeEventSource {
  static last: FakeEventSource | null = null;

  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    act(() => {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(new MessageEvent(type, { data: JSON.stringify(data) }));
      }
    });
  }

  emitBare(type: string): void {
    act(() => {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(new Event(type));
      }
    });
  }
}

function source(): FakeEventSource {
  const instance = FakeEventSource.last;
  if (instance === null) throw new Error('no EventSource was opened');
  return instance;
}

const base = { jobId: JOB, tenantId: TENANT };

const jobStarted = {
  ...base,
  kind: 'job_started',
  sequence: 0,
  at: '2026-08-02T10:00:00.000Z',
  memoryVersionId: VERSION_ID,
  version: 4,
  resumed: false,
};

function routeStarted(sequence: number, path: string) {
  return {
    ...base,
    kind: 'route_started',
    sequence,
    at: '2026-08-02T10:00:01.000Z',
    path,
    depth: 1,
  };
}

function routeIndexed(sequence: number, routePattern: string, elementCount: number) {
  return {
    ...base,
    kind: 'route_indexed',
    sequence,
    at: '2026-08-02T10:00:02.000Z',
    screenId: SCREEN_A,
    routePattern,
    stateFingerprint: 'a'.repeat(64),
    elementCount,
    durationMs: 850,
  };
}

beforeEach(() => {
  FakeEventSource.last = null;
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderScreen(pageCap: number | null = 50, jobId: string | null = JOB) {
  render(<IndexingLive applicationId={APPLICATION_ID} jobId={jobId} pageCap={pageCap} />);
}

describe('IndexingLive — connecting', () => {
  it('subscribes to the console’s own proxy route, not the gateway', () => {
    renderScreen();

    // `EventSource` cannot send an Authorization header, which is why the proxy exists.
    expect(source().url).toBe(`/api/applications/${APPLICATION_ID}/index-progress?jobId=${JOB}`);
  });

  it('omits the job filter when following the most recent job', () => {
    renderScreen(50, null);

    expect(source().url).toBe(`/api/applications/${APPLICATION_ID}/index-progress`);
  });

  it('shows skeletons while waiting, never a spinner', () => {
    renderScreen();

    const skeletons = document.querySelectorAll('.skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.spinner, [class*="spin"]')).toHaveLength(0);
  });

  it('shapes the skeleton rows like the rows that will replace them', () => {
    renderScreen();
    const [routesTable] = screen.getAllByRole('table');
    const headerCells = routesTable?.querySelectorAll('thead th').length ?? 0;
    const skeletonRow = routesTable?.querySelector('tbody tr[aria-hidden="true"]');

    // The point of a skeleton over a spinner is that the page does not jump when the data lands.
    expect(headerCells).toBe(5);
    expect(skeletonRow?.querySelectorAll('td')).toHaveLength(headerCells);
  });

  it('hides the placeholders from assistive technology', () => {
    renderScreen();

    // A screen reader should hear the status line, not sixty grey boxes.
    for (const node of document.querySelectorAll('.skeleton')) {
      expect(node.closest('[aria-hidden="true"]')).not.toBeNull();
    }
  });

  it('says it is connecting rather than claiming progress it has not seen', () => {
    renderScreen();

    expect(screen.getAllByText(/Connecting to the progress stream/).length).toBeGreaterThan(0);
  });
});

describe('IndexingLive — a running crawl', () => {
  it('replaces the skeletons with real rows as routes arrive', () => {
    renderScreen();
    source().emitBare('open');
    source().emit('job_started', jobStarted);
    source().emit('route_started', routeStarted(1, '/orders/8f21'));

    expect(document.querySelectorAll('.skeleton')).toHaveLength(0);
    expect(screen.getByText('/orders/8f21')).toBeDefined();
    expect(screen.getAllByText(/^crawling$/).length).toBe(1);
  });

  it('fills the pattern in on the same row once the route is indexed', () => {
    renderScreen();
    source().emit('route_started', routeStarted(1, '/orders/8f21'));
    source().emit('route_indexed', routeIndexed(2, '/orders/:id', 41));

    const rows = screen.getAllByRole('table')[0]?.querySelectorAll('tbody tr') ?? [];
    expect(rows).toHaveLength(1);
    expect(screen.getByText('/orders/8f21')).toBeDefined();
    expect(screen.getByText('/orders/:id')).toBeDefined();
  });

  it('counts what it has seen, and nothing it has not', () => {
    renderScreen();
    source().emit('job_started', jobStarted);
    source().emit('route_started', routeStarted(1, '/orders'));
    source().emit('route_indexed', routeIndexed(2, '/orders', 41));
    source().emit('edge_recorded', {
      ...base,
      kind: 'edge_recorded',
      sequence: 3,
      at: '2026-08-02T10:00:03.000Z',
      fromScreenId: SCREEN_A,
      toScreenId: SCREEN_B,
      triggerElementKey: 'orders.filter.pending',
      confidence: 0.91,
    });

    const chips = document.querySelector('.chips')?.textContent ?? '';
    expect(chips).toContain('1Routes indexed');
    expect(chips).toContain('41Elements');
    expect(chips).toContain('1Navigation edges');
    expect(chips).toContain('0Routes skipped');
  });

  it('shows the memory version the crawl is filling in', () => {
    renderScreen();
    source().emit('job_started', { ...jobStarted, resumed: true });

    expect(screen.getByText('v4 (resumed)')).toBeDefined();
  });

  it('names the reason a route was skipped', () => {
    renderScreen();
    source().emit('route_skipped', {
      ...base,
      kind: 'route_skipped',
      sequence: 1,
      at: '2026-08-02T10:00:03.000Z',
      path: '/admin',
      reason: 'off_allowlist',
    });

    expect(screen.getByText(/skipped — off allowlist/)).toBeDefined();
  });

  it('reports a gap in the sequence instead of quietly undercounting', () => {
    renderScreen();
    source().emit('job_started', jobStarted);
    source().emit('route_indexed', routeIndexed(5, '/orders', 41));

    expect(screen.getByText(/gap in the event sequence/)).toBeDefined();
  });

  it('surfaces a frame it could not use rather than dropping it', () => {
    renderScreen();
    source().emit('route_indexed', { ...routeIndexed(1, '/orders', 41), elementCount: -2 });

    expect(screen.getByText(/did not match the contract/)).toBeDefined();
  });
});

describe('IndexingLive — the progress bar', () => {
  it('is determinate against the page cap the tester set', () => {
    renderScreen(10);
    source().emit('route_started', routeStarted(1, '/orders'));
    source().emit('route_indexed', routeIndexed(2, '/orders', 41));

    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('10');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.className).not.toContain('indeterminate');
  });

  it('stays indeterminate without a cap rather than inventing a denominator', () => {
    renderScreen(null);
    source().emit('route_started', routeStarted(1, '/orders'));
    source().emit('route_indexed', routeIndexed(2, '/orders', 41));

    const bar = screen.getByRole('progressbar');
    // A progress bar that is lying is worse than no progress bar.
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(bar.className).toContain('indeterminate');
    expect(bar.getAttribute('aria-valuetext')).toContain('no page cap in this URL');
  });

  it('always carries a text alternative, determinate or not', () => {
    renderScreen(10);

    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBeTruthy();
  });
});

describe('IndexingLive — terminal states', () => {
  it('reports completion with the job’s own totals', () => {
    renderScreen(50);
    source().emit('route_started', routeStarted(1, '/orders'));
    source().emit('route_indexed', routeIndexed(2, '/orders', 41));
    source().emit('job_completed', {
      ...base,
      kind: 'job_completed',
      sequence: 3,
      at: '2026-08-02T10:05:00.000Z',
      memoryVersionId: VERSION_ID,
      screenCount: 12,
      elementCount: 480,
      edgeCount: 30,
      durationMs: 300_000,
    });

    expect(screen.getAllByText(/Index complete/).length).toBeGreaterThan(0);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    expect(document.querySelector('.chips')?.textContent).toContain('12Routes indexed');
  });

  it('announces a failure with its taxonomy code and detail', () => {
    renderScreen();
    source().emit('job_failed', {
      ...base,
      kind: 'job_failed',
      sequence: 1,
      at: '2026-08-02T10:04:00.000Z',
      memoryVersionId: VERSION_ID,
      code: 'ssrf_rejected',
      detail: 'the base URL resolved to a private address',
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('ssrf_rejected');
    expect(alert.textContent).toContain('private address');
  });

  it('treats a transport drop as reconnecting, not as a failure', () => {
    renderScreen();
    source().emit('job_started', jobStarted);
    source().emitBare('open');
    source().emitBare('error');

    expect(screen.getAllByText(/Indexing — reconnecting/).length).toBeGreaterThan(0);
    expect(screen.getByText(/connection dropped; reconnecting/)).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    // Closing would stop the browser retrying, on a crawl that is still running.
    expect(source().closed).toBe(false);
  });

  it('reports the gateway’s own error frame as the stream stopping', () => {
    renderScreen();
    source().emit('job_started', jobStarted);
    source().emit('error', { code: 'internal', message: 'redis read failed' });

    expect(screen.getAllByText(/The progress stream stopped/).length).toBeGreaterThan(0);
    expect(source().closed).toBe(true);
  });

  it('keeps the routes it had when the crawl failed', () => {
    renderScreen();
    source().emit('route_started', routeStarted(1, '/orders/8f21'));
    source().emit('route_indexed', routeIndexed(2, '/orders/:id', 41));
    source().emit('job_failed', {
      ...base,
      kind: 'job_failed',
      sequence: 3,
      at: '2026-08-02T10:04:00.000Z',
      memoryVersionId: VERSION_ID,
      code: 'navigation_failed',
      detail: 'the base URL did not respond',
    });

    // A failed crawl is not an empty one: what it did index before it stopped is still shown.
    expect(screen.getByText('/orders/8f21')).toBeDefined();
    expect(screen.getByText('/orders/:id')).toBeDefined();
  });
});

describe('IndexingLive — accessibility and lifecycle', () => {
  it('announces changes through one polite live region, not row by row', () => {
    renderScreen();
    const status = document.querySelector('[role="status"]');

    // A screen reader reading out two hundred routes is noise, not progress.
    expect(status).not.toBeNull();
    expect(status?.className).toContain('visually-hidden');
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it('gives every table a caption and scoped headers', () => {
    renderScreen();

    for (const table of screen.getAllByRole('table')) {
      expect(table.querySelector('caption')?.textContent).toBeTruthy();
      for (const header of table.querySelectorAll('th')) {
        expect(header.getAttribute('scope')).toBe('col');
      }
    }
  });

  it('closes the stream on unmount, so a background tab holds nothing open', () => {
    const { unmount } = render(
      <IndexingLive applicationId={APPLICATION_ID} jobId={JOB} pageCap={50} />,
    );

    unmount();

    expect(source().closed).toBe(true);
  });

  it('renders no element text from the application under test', () => {
    // CLAUDE.md § PII: the event contract carries no accessible names, and this screen must not
    // become the place one appears. Paths and ids are structure; text content is not.
    renderScreen();
    source().emit('route_started', routeStarted(1, '/orders'));
    source().emit('route_indexed', routeIndexed(2, '/orders', 41));

    expect(document.body.textContent).not.toContain('stateFingerprint');
  });
});

describe('the console stylesheet', () => {
  it('gives every animation a prefers-reduced-motion escape', () => {
    // Vestibular triggers are a hard accessibility requirement, and both animations here are
    // decorative — the text beside them carries the same information.
    const animated = [...consoleCss.matchAll(/animation:\s*(\w+)/g)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined && name !== 'none');
    const reduced = consoleCss.slice(consoleCss.indexOf('@media (prefers-reduced-motion: reduce)'));

    expect(animated.length).toBeGreaterThan(0);
    expect(new Set(animated)).toEqual(new Set(['sweep', 'pulse']));
    for (const rule of ['.bar.indeterminate > .fill', '.skeleton']) {
      expect(reduced).toContain(rule);
    }
    expect(consoleCss.match(/@media \(prefers-reduced-motion: reduce\)/g)).toHaveLength(2);
  });

  it('keeps every animation named in a reduced-motion block that turns it off', () => {
    for (const block of consoleCss.split('@media (prefers-reduced-motion: reduce)').slice(1)) {
      expect(block).toContain('animation: none');
    }
  });
});
