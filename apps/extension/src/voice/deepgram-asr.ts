import type { StreamingAsr, StreamingAsrEvents } from './streaming-asr.js';

/**
 * Deepgram streaming ASR — the first {@link StreamingAsr} implementation.
 *
 * It speaks Deepgram's realtime protocol over a plain `WebSocket`: 16 kHz mono `linear16` frames
 * up, JSON results down. No Deepgram SDK — the SDK is a Node client, and this runs in an offscreen
 * document; the wire protocol is small enough to speak directly, which also keeps a second provider
 * a matter of writing another file against the same interface rather than swapping SDKs.
 *
 * ## Credentials
 *
 * A browser `WebSocket` cannot set an `Authorization` header, so Deepgram takes the key as a
 * WebSocket subprotocol: `new WebSocket(url, ['token', key])`. The key here is **short-lived and
 * supplied per session** by the service worker (see `messages.ts` `OffscreenCommand.start`), never
 * a durable secret compiled into the extension — CLAUDE.md rule #10.
 *
 * ## Finalize vs. close
 *
 * `finish()` sends Deepgram's `Finalize`, which flushes a final for the audio sent so far and
 * leaves the socket open for the next utterance. `close()` sends `CloseStream` and tears down. The
 * two being distinct is what the pipeline's warm-socket, per-utterance model needs.
 */

/** The slice of `WebSocket` this client uses, so a test can supply a fake. */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: ArrayBufferView | ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string, protocols: string[]) => SocketLike;

export interface DeepgramConfig {
  /** Base endpoint, e.g. `wss://api.deepgram.com/v1/listen`. From config, never hardcoded. */
  readonly endpoint: string;
  /** Short-lived key, supplied per session. */
  readonly token: string;
  readonly model: string;
  readonly language: string;
  /** Deepgram's endpointing silence, in ms. Governs when an utterance is finalized. */
  readonly endpointingMs?: number;
  /** Injected so a test drives a fake socket; defaults to the global `WebSocket`. */
  readonly socketFactory?: SocketFactory;
  /** KeepAlive cadence to stop Deepgram closing an idle socket while the tester pauses. */
  readonly keepAliveMs?: number;
  readonly setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

const OPEN = 1;
const DEFAULT_ENDPOINTING_MS = 300;
const DEFAULT_KEEPALIVE_MS = 5_000;

function buildUrl(config: DeepgramConfig): string {
  const url = new URL(config.endpoint);
  const params: Record<string, string> = {
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    model: config.model,
    language: config.language,
    interim_results: 'true',
    endpointing: String(config.endpointingMs ?? DEFAULT_ENDPOINTING_MS),
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Pull the transcript and finality out of a Deepgram results message, defensively.
 *
 * The socket is a network peer; a message that is not the shape we expect is ignored rather than
 * thrown on. Returns null for anything that is not a non-empty transcript result.
 */
function readResult(data: unknown): { transcript: string; isFinal: boolean } | null {
  if (typeof data !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as {
    type?: unknown;
    is_final?: unknown;
    speech_final?: unknown;
    channel?: { alternatives?: Array<{ transcript?: unknown }> };
  };
  if (record.type !== 'Results') return null;

  const transcript = record.channel?.alternatives?.[0]?.transcript;
  if (typeof transcript !== 'string' || transcript.length === 0) return null;

  const isFinal = record.is_final === true || record.speech_final === true;
  return { transcript, isFinal };
}

export function createDeepgramAsr(config: DeepgramConfig): StreamingAsr {
  const factory: SocketFactory =
    config.socketFactory ??
    ((url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike);
  const setIntervalFn = config.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = config.clearIntervalFn ?? ((handle) => clearInterval(handle));

  let socket: SocketLike | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  function stopKeepAlive(): void {
    if (keepAlive !== null) {
      clearIntervalFn(keepAlive);
      keepAlive = null;
    }
  }

  return {
    open(events: StreamingAsrEvents): void {
      if (socket !== null) return;
      // The key travels as a subprotocol, the only header-free way to authenticate a browser
      // WebSocket. It is not placed in the URL, where it would land in access logs.
      const ws = factory(buildUrl(config), ['token', config.token]);
      ws.binaryType = 'arraybuffer';
      socket = ws;

      ws.onopen = (): void => {
        keepAlive = setIntervalFn(() => {
          if (socket?.readyState === OPEN) socket.send(JSON.stringify({ type: 'KeepAlive' }));
        }, config.keepAliveMs ?? DEFAULT_KEEPALIVE_MS);
        events.onOpen();
      };

      ws.onmessage = (event): void => {
        const result = readResult(event.data);
        if (result === null) return;
        if (result.isFinal) events.onFinal(result.transcript);
        else events.onPartial(result.transcript);
      };

      ws.onclose = (event): void => {
        stopKeepAlive();
        socket = null;
        events.onClose({ code: event.code, reason: event.reason, wasClean: event.wasClean });
      };

      ws.onerror = (event): void => {
        events.onError(event);
      };
    },

    send(frame: Int16Array): void {
      if (socket?.readyState !== OPEN) return;
      // A view over the frame's own buffer — no copy on the hot path.
      socket.send(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
    },

    finish(): void {
      if (socket?.readyState === OPEN) socket.send(JSON.stringify({ type: 'Finalize' }));
    },

    close(): void {
      stopKeepAlive();
      if (socket !== null) {
        if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: 'CloseStream' }));
        socket.close();
        socket = null;
      }
    },

    get isOpen(): boolean {
      return socket?.readyState === OPEN;
    },
  };
}
