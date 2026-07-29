import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeepgramAsr, type DeepgramConfig, type SocketLike } from './deepgram-asr.js';

const OPEN = 1;
const CONNECTING = 0;

/** A hand-driven WebSocket stand-in: the test sets readyState and fires the handlers. */
class FakeSocket implements SocketLike {
  binaryType = 'blob';
  readyState = CONNECTING;
  closed = false;
  readonly sent: (ArrayBufferView | ArrayBuffer | string)[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: ArrayBufferView | ArrayBuffer | string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

function fakeEvents() {
  return {
    onOpen: vi.fn<() => void>(),
    onPartial: vi.fn<(transcript: string) => void>(),
    onFinal: vi.fn<(transcript: string) => void>(),
    onClose: vi.fn<(info: { code: number; reason: string; wasClean: boolean }) => void>(),
    onError: vi.fn<(error: unknown) => void>(),
  };
}

function results(transcript: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'Results', channel: { alternatives: [{ transcript }] }, ...extra });
}

let socket: FakeSocket;
let keepAliveFn: (() => void) | null;
const clearIntervalFn = vi.fn();

function makeAsr(overrides: Partial<DeepgramConfig> = {}): {
  asr: ReturnType<typeof createDeepgramAsr>;
  captured: { url: string; protocols: string[] };
  events: ReturnType<typeof fakeEvents>;
} {
  const captured = { url: '', protocols: [] as string[] };
  const config: DeepgramConfig = {
    endpoint: 'wss://api.deepgram.com/v1/listen',
    token: 'secret-token',
    model: 'nova-2',
    language: 'en-US',
    endpointingMs: 300,
    socketFactory: (url, protocols) => {
      captured.url = url;
      captured.protocols = protocols;
      socket = new FakeSocket();
      return socket;
    },
    setIntervalFn: (fn) => {
      keepAliveFn = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn,
    ...overrides,
  };
  const asr = createDeepgramAsr(config);
  const events = fakeEvents();
  asr.open(events);
  return { asr, captured, events };
}

beforeEach(() => {
  keepAliveFn = null;
  clearIntervalFn.mockClear();
});

describe('deepgram client — connection', () => {
  it('builds the linear16 16 kHz URL with interim results', () => {
    const { captured } = makeAsr();
    const url = new URL(captured.url);
    expect(url.searchParams.get('encoding')).toBe('linear16');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(url.searchParams.get('channels')).toBe('1');
    expect(url.searchParams.get('interim_results')).toBe('true');
    expect(url.searchParams.get('model')).toBe('nova-2');
    expect(url.searchParams.get('language')).toBe('en-US');
    expect(url.searchParams.get('endpointing')).toBe('300');
  });

  it('carries the key as a subprotocol, never in the URL', () => {
    const { captured } = makeAsr();
    expect(captured.protocols).toEqual(['token', 'secret-token']);
    expect(captured.url).not.toContain('secret-token');
    expect(socket.binaryType).toBe('arraybuffer');
  });

  it('reports open and pings KeepAlive only while the socket is up', () => {
    const { events } = makeAsr();
    socket.readyState = OPEN;
    socket.onopen?.({});
    expect(events.onOpen).toHaveBeenCalledTimes(1);

    keepAliveFn?.();
    expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({ type: 'KeepAlive' });

    socket.readyState = CONNECTING;
    const before = socket.sent.length;
    keepAliveFn?.();
    expect(socket.sent.length).toBe(before); // no ping while not open
  });
});

describe('deepgram client — results mapping', () => {
  it('routes interim and final Results to the right callback', () => {
    const { events } = makeAsr();
    socket.onmessage?.({ data: results('show me') });
    expect(events.onPartial).toHaveBeenCalledWith('show me');

    socket.onmessage?.({ data: results('show me the pending orders', { is_final: true }) });
    expect(events.onFinal).toHaveBeenCalledWith('show me the pending orders');

    socket.onmessage?.({ data: results('show me the pending orders', { speech_final: true }) });
    expect(events.onFinal).toHaveBeenCalledTimes(2);
  });

  it('ignores empty transcripts, non-Results messages, and malformed frames', () => {
    const { events } = makeAsr();
    socket.onmessage?.({ data: results('') });
    socket.onmessage?.({ data: JSON.stringify({ type: 'Metadata' }) });
    socket.onmessage?.({ data: 'not json at all' });
    socket.onmessage?.({ data: 42 });
    expect(events.onPartial).not.toHaveBeenCalled();
    expect(events.onFinal).not.toHaveBeenCalled();
  });
});

describe('deepgram client — send, finalize, close', () => {
  it('sends a frame as bytes only while open', () => {
    const { asr } = makeAsr();
    const frame = Int16Array.of(1, 2, 3);

    socket.readyState = CONNECTING;
    asr.send(frame);
    expect(socket.sent).toHaveLength(0);

    socket.readyState = OPEN;
    asr.send(frame);
    const last = socket.sent.at(-1);
    expect(last).toBeInstanceOf(Uint8Array);
    expect((last as Uint8Array).byteLength).toBe(frame.byteLength);
  });

  it('Finalize keeps the socket open; CloseStream tears it down', () => {
    const { asr } = makeAsr();
    socket.readyState = OPEN;
    socket.onopen?.({}); // starts the KeepAlive that close() must later clear

    asr.finish();
    expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({ type: 'Finalize' });
    expect(socket.closed).toBe(false);

    asr.close();
    expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({ type: 'CloseStream' });
    expect(socket.closed).toBe(true);
    expect(clearIntervalFn).toHaveBeenCalled();
  });

  it('surfaces a close with its cleanliness and stops the KeepAlive', () => {
    const { events } = makeAsr();
    socket.readyState = OPEN;
    socket.onopen?.({}); // starts the KeepAlive so the close has something to clear
    socket.onclose?.({ code: 1006, reason: 'gone', wasClean: false });
    expect(events.onClose).toHaveBeenCalledWith({ code: 1006, reason: 'gone', wasClean: false });
    expect(clearIntervalFn).toHaveBeenCalled();
  });
});
