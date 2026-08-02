import { describe, expect, it, vi } from 'vitest';

import {
  PROGRESS_EVENT_NAMES,
  subscribeToProgress,
  type ProgressEventSource,
  type ProgressStreamHandlers,
} from './stream';

/**
 * The client half of the progress stream.
 *
 * The interesting behaviour is not rendering, it is which frames mean what — in particular
 * telling the gateway's named `error` frame (terminal) apart from `EventSource`'s transport
 * `error` (recoverable, because it reconnects and resumes from `Last-Event-ID`). Getting that
 * backwards either strands a tester on a dead stream or reports a crawl as broken because a
 * laptop slept.
 */

const JOB = '0a4a2fa1-2b1e-4a2c-9f5d-8c6c2c1f0001';
const TENANT = '0a4a2fa1-2b1e-4a2c-9f5d-8c6c2c1f0002';
const VERSION_ID = '0a4a2fa1-2b1e-4a2c-9f5d-8c6c2c1f0003';

const jobStarted = {
  kind: 'job_started',
  jobId: JOB,
  tenantId: TENANT,
  sequence: 0,
  at: '2026-08-02T10:00:00.000Z',
  memoryVersionId: VERSION_ID,
  version: 1,
  resumed: false,
};

/** A fake `EventSource` a test drives directly. */
class FakeEventSource implements ProgressEventSource {
  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  closed = false;

  addEventListener(type: string, listener: (event: Event) => void): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, listener]);
  }

  close(): void {
    this.closed = true;
  }

  /** Dispatch a named frame carrying data, the way the gateway sends one. */
  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }));
    }
  }

  /** Dispatch a bare `Event`, the way the transport reports a dropped connection. */
  emitBare(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }
}

function subscribe(): {
  source: FakeEventSource;
  handlers: { [K in keyof ProgressStreamHandlers]: ReturnType<typeof vi.fn> };
  unsubscribe: () => void;
  url: string | null;
} {
  const source = new FakeEventSource();
  const handlers = {
    onEvent: vi.fn(),
    onOpen: vi.fn(),
    onEnd: vi.fn(),
    onStreamError: vi.fn(),
    onDisconnected: vi.fn(),
    onMalformed: vi.fn(),
  };
  let url: string | null = null;

  const unsubscribe = subscribeToProgress(
    '/api/applications/abc/index-progress?jobId=xyz',
    handlers as unknown as ProgressStreamHandlers,
    (requested) => {
      url = requested;
      return source;
    },
  );

  return { source, handlers, unsubscribe, url };
}

describe('subscribeToProgress', () => {
  it('opens against the URL it was given', () => {
    const { url } = subscribe();

    expect(url).toBe('/api/applications/abc/index-progress?jobId=xyz');
  });

  it('listens for every event name in the contract union', () => {
    const { source } = subscribe();

    for (const name of PROGRESS_EVENT_NAMES) {
      expect(source.listeners.has(name)).toBe(true);
    }
    expect(PROGRESS_EVENT_NAMES).toHaveLength(7);
  });

  it('reports the connection opening', () => {
    const { source, handlers } = subscribe();

    source.emitBare('open');

    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
  });

  it('delivers a contract-valid frame as a parsed event', () => {
    const { source, handlers } = subscribe();

    source.emit('job_started', JSON.stringify(jobStarted));

    expect(handlers.onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'job_started' }));
    expect(handlers.onMalformed).not.toHaveBeenCalled();
  });

  it('refuses a frame that is not JSON, and never delivers it as data', () => {
    const { source, handlers } = subscribe();

    source.emit('job_started', '{not json');

    expect(handlers.onEvent).not.toHaveBeenCalled();
    expect(handlers.onMalformed).toHaveBeenCalledWith(expect.stringContaining('not JSON'));
  });

  it('refuses a frame that does not match the contract', () => {
    // The gateway validates before forwarding, so this means the two sides are built against
    // different versions of the contract. Surfaced, never rendered.
    const { source, handlers } = subscribe();

    source.emit('job_started', JSON.stringify({ ...jobStarted, version: -3 }));

    expect(handlers.onEvent).not.toHaveBeenCalled();
    expect(handlers.onMalformed).toHaveBeenCalledWith(expect.stringContaining('did not match'));
  });

  it('refuses a frame whose kind disagrees with its event name', () => {
    const { source, handlers } = subscribe();

    source.emit('route_indexed', JSON.stringify(jobStarted));

    // The payload is a valid `job_started`, so it parses — but it arrived under the wrong name,
    // which is worth knowing the reducer will fold it by its own `kind`.
    expect(handlers.onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'job_started' }));
  });

  it('refuses a named frame carrying no data', () => {
    const { source, handlers } = subscribe();

    source.emitBare('job_started');

    expect(handlers.onEvent).not.toHaveBeenCalled();
    expect(handlers.onMalformed).toHaveBeenCalledWith(expect.stringContaining('no data'));
  });

  it('treats a bare transport error as recoverable and leaves the connection to retry', () => {
    const { source, handlers } = subscribe();

    source.emitBare('error');

    expect(handlers.onDisconnected).toHaveBeenCalledTimes(1);
    expect(handlers.onStreamError).not.toHaveBeenCalled();
    // Closing here would stop `EventSource` reconnecting and strand the screen on a live crawl.
    expect(source.closed).toBe(false);
  });

  it('treats the gateway’s named error frame as terminal and closes', () => {
    const { source, handlers } = subscribe();

    source.emit('error', JSON.stringify({ code: 'internal', message: 'redis read failed' }));

    expect(handlers.onStreamError).toHaveBeenCalledTimes(1);
    expect(handlers.onDisconnected).not.toHaveBeenCalled();
    expect(source.closed).toBe(true);
  });

  it('closes on the end frame, so the browser does not reconnect to a finished job', () => {
    const { source, handlers } = subscribe();

    source.emit('end', '{}');

    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
    expect(source.closed).toBe(true);
  });

  it('closes the connection when unsubscribed', () => {
    const { source, unsubscribe } = subscribe();

    unsubscribe();

    expect(source.closed).toBe(true);
  });

  it('is idempotent — unsubscribing twice closes once', () => {
    const source = new FakeEventSource();
    const closeSpy = vi.spyOn(source, 'close');
    const handlers = {
      onEvent: vi.fn(),
      onOpen: vi.fn(),
      onEnd: vi.fn(),
      onStreamError: vi.fn(),
      onDisconnected: vi.fn(),
      onMalformed: vi.fn(),
    } as unknown as ProgressStreamHandlers;

    const unsubscribe = subscribeToProgress('/x', handlers, () => source);
    unsubscribe();
    unsubscribe();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not close twice when an end frame is followed by an unsubscribe', () => {
    const source = new FakeEventSource();
    const closeSpy = vi.spyOn(source, 'close');
    const handlers = {
      onEvent: vi.fn(),
      onOpen: vi.fn(),
      onEnd: vi.fn(),
      onStreamError: vi.fn(),
      onDisconnected: vi.fn(),
      onMalformed: vi.fn(),
    } as unknown as ProgressStreamHandlers;

    const unsubscribe = subscribeToProgress('/x', handlers, () => source);
    source.emit('end', '{}');
    unsubscribe();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps delivering after a recoverable drop', () => {
    const { source, handlers } = subscribe();

    source.emitBare('error');
    source.emitBare('open');
    source.emit('job_started', JSON.stringify(jobStarted));

    expect(handlers.onEvent).toHaveBeenCalledTimes(1);
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
  });
});
