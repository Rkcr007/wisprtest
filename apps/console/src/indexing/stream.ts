import { IndexProgressEvent } from 'protocol';

/**
 * The client half of the progress stream: an `EventSource` against the console's proxy route.
 *
 * Kept out of React so it can be tested against a fake `EventSource` — the interesting behaviour
 * here is not rendering, it is which frames mean what, and that is worth asserting without a DOM
 * fixture.
 *
 * ## The two kinds of `error`
 *
 * `EventSource` dispatches a plain `Event` named `error` when the connection drops, and the
 * gateway *also* sends a named `error` frame when its read of the Redis stream fails
 * (`apps/gateway/src/routes/crawl.ts`). They arrive at the same listener. They are told apart by
 * whether the event carries `data`: a `MessageEvent` is the gateway speaking, a bare `Event` is
 * the transport. Only the transport one is recoverable — `EventSource` reconnects on its own and
 * resumes from `Last-Event-ID`, so it is reported as a warning rather than as a failure.
 */

/** Every `kind` in the contract's union, which is also every SSE event name the gateway sends. */
export const PROGRESS_EVENT_NAMES = [
  'job_started',
  'route_started',
  'route_indexed',
  'route_skipped',
  'edge_recorded',
  'job_completed',
  'job_failed',
] as const;

export interface ProgressStreamHandlers {
  /** A contract-valid progress event. */
  readonly onEvent: (event: IndexProgressEvent) => void;
  /** The connection opened, or reopened after a drop. */
  readonly onOpen: () => void;
  /** The gateway's named `end` frame: the job is over and the stream is closed deliberately. */
  readonly onEnd: () => void;
  /** The gateway's named `error` frame: its own read failed. Terminal. */
  readonly onStreamError: () => void;
  /** The transport dropped. `EventSource` will retry; nothing is lost. */
  readonly onDisconnected: () => void;
  /** A frame that is not a valid `IndexProgressEvent`. Never rendered as data. */
  readonly onMalformed: (detail: string) => void;
}

/** Minimal surface of `EventSource` used here, so a test can supply a fake. */
export interface ProgressEventSource {
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  close: () => void;
}

export type ProgressEventSourceFactory = (url: string) => ProgressEventSource;

const defaultFactory: ProgressEventSourceFactory = (url) => new EventSource(url);

/**
 * Subscribe to one job's progress. Returns the unsubscribe.
 *
 * The returned function closes the connection, which is what stops a background tab holding a
 * Redis reader open on the gateway for as long as it is left there.
 */
export function subscribeToProgress(
  url: string,
  handlers: ProgressStreamHandlers,
  factory: ProgressEventSourceFactory = defaultFactory,
): () => void {
  const source = factory(url);
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    source.close();
  };

  source.addEventListener('open', () => {
    handlers.onOpen();
  });

  for (const name of PROGRESS_EVENT_NAMES) {
    source.addEventListener(name, (event: Event) => {
      const data = messageData(event);
      if (data === null) {
        handlers.onMalformed(`the ${name} frame carried no data`);
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        handlers.onMalformed(`the ${name} frame was not JSON`);
        return;
      }

      const parsed = IndexProgressEvent.safeParse(payload);
      if (!parsed.success) {
        // The gateway validates against the same contract before forwarding, so this means the
        // two sides are built against different versions of it. Surfaced, never rendered.
        handlers.onMalformed(`the ${name} frame did not match the contract`);
        return;
      }

      handlers.onEvent(parsed.data);
    });
  }

  source.addEventListener('end', () => {
    // Without this the browser would reconnect to sit on a job that has already finished.
    close();
    handlers.onEnd();
  });

  source.addEventListener('error', (event: Event) => {
    if (messageData(event) === null) {
      handlers.onDisconnected();
      return;
    }
    close();
    handlers.onStreamError();
  });

  return close;
}

/** The `data` of a `MessageEvent`, or null when this is a bare transport `Event`. */
function messageData(event: Event): string | null {
  const data: unknown = (event as MessageEvent<unknown>).data;
  return typeof data === 'string' ? data : null;
}
