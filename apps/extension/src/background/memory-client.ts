import { MemorySnapshot } from 'protocol';

/**
 * The memory snapshot client, in the service worker.
 *
 * docs/BUILD-PLAN.md Phase 8: "fetch snapshot on attach, hold in memory, expose to the content
 * script via a typed message channel. Handle version mismatch by refetching." This is the fetch,
 * the hold and the refetch; the content-script exposure is the attach controller pushing what it
 * holds over the HUD port.
 *
 * Why the worker and not the content script: the snapshot fetch needs the scoped token, and the
 * token never leaves the worker (see `token-store.ts` and `messaging.ts`). The content script is
 * handed the snapshot — redacted structure, safe to cross — and never the credential that fetched
 * it.
 *
 * ## What the statuses mean
 *
 * - **200** — a snapshot, validated against the contract before it is trusted.
 * - **503 `memory_snapshot_unavailable`** — a real answer, not a failure: the application is still
 *   indexing, or its first crawl failed. Returned as `null`, and the extension attaches with
 *   nothing to resolve against yet rather than treating a normal state as an error.
 * - **401 / 403** — the token is not valid; the caller drops it and re-authenticates.
 * - **network / 5xx** — the control plane is having a bad moment; retried with backoff.
 */

/** Thrown when the tester needs to re-authenticate. Never retried. */
export class SnapshotUnauthorizedError extends Error {
  readonly code = 'unauthenticated' as const;
  constructor() {
    super('the gateway rejected the token while loading memory');
    this.name = 'SnapshotUnauthorizedError';
  }
}

/** Thrown when the control plane could not be reached or kept failing. */
export class SnapshotUnreachableError extends Error {
  readonly code = 'unreachable' as const;
  constructor(detail: string) {
    super(`could not load memory: ${detail}`);
    this.name = 'SnapshotUnreachableError';
  }
}

/** Thrown when the gateway answered with something that is not a `MemorySnapshot`. */
export class MalformedSnapshotError extends Error {
  readonly code = 'internal' as const;
  constructor(detail: string) {
    super(`the gateway returned a malformed snapshot: ${detail}`);
    this.name = 'MalformedSnapshotError';
  }
}

export interface MemoryClientOptions {
  /** Origin of the control plane. Must match the manifest's `host_permissions`. */
  readonly gatewayOrigin: string;
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly fetch?: typeof globalThis.fetch;
}

export interface MemoryClient {
  /** Fetch the active snapshot for an application, validate it, and hold it. Null when none yet. */
  load(applicationId: string, bearerToken: string): Promise<MemorySnapshot | null>;
  /** The held snapshot for an application, if one has been loaded. */
  get(applicationId: string): MemorySnapshot | null;
  /** Forget the held snapshot — on a version mismatch, before a refetch, or on detach. */
  invalidate(applicationId: string): void;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 250;

/** The route this client calls. */
export function snapshotPath(applicationId: string): string {
  return `/v1/memory/${applicationId}/snapshot`;
}

export function createMemoryClient(options: MemoryClientOptions): MemoryClient {
  const {
    gatewayOrigin,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    backoffMs = DEFAULT_BACKOFF_MS,
    sleep = defaultSleep,
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
  } = options;

  const held = new Map<string, MemorySnapshot>();

  async function load(applicationId: string, bearerToken: string): Promise<MemorySnapshot | null> {
    const endpoint = new URL(snapshotPath(applicationId), gatewayOrigin).href;
    let lastFailure = 'no attempt was made';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'GET',
          headers: { authorization: `Bearer ${bearerToken}` },
        });
      } catch (error: unknown) {
        lastFailure = error instanceof Error ? error.message : 'network error';
        if (attempt === maxAttempts) break;
        await sleep(backoffMs * 2 ** (attempt - 1));
        continue;
      }

      if (response.status === 401 || response.status === 403) throw new SnapshotUnauthorizedError();

      // A 503 that names the snapshot as unavailable is a real "not indexed yet", not a transient
      // failure — no point retrying it. Any other 5xx (or 429) is the control plane wobbling.
      if (response.status === 503 && (await codeOf(response)) === 'memory_snapshot_unavailable') {
        held.delete(applicationId);
        return null;
      }
      if (response.status >= 500 || response.status === 429) {
        lastFailure = `HTTP ${String(response.status)}`;
        if (attempt === maxAttempts) break;
        await sleep(backoffMs * 2 ** (attempt - 1));
        continue;
      }

      if (!response.ok) throw new MalformedSnapshotError(`HTTP ${String(response.status)}`);

      let payload: unknown;
      try {
        // The platform transparently gunzips `content-encoding: gzip`, so this is plain JSON here.
        payload = await response.json();
      } catch (error: unknown) {
        throw new MalformedSnapshotError(error instanceof Error ? error.message : 'invalid JSON');
      }

      const parsed = MemorySnapshot.safeParse(payload);
      if (!parsed.success) {
        // Validated before it is held: an unvalidated snapshot would be handed to the resolver and
        // fail in a tester's tab minutes later, far from the response that produced it.
        throw new MalformedSnapshotError(
          parsed.error.issues.map((issue) => issue.path.join('.') || 'root').join(', '),
        );
      }

      held.set(applicationId, parsed.data);
      return parsed.data;
    }

    throw new SnapshotUnreachableError(lastFailure);
  }

  return {
    load,
    get(applicationId): MemorySnapshot | null {
      return held.get(applicationId) ?? null;
    },
    invalidate(applicationId): void {
      held.delete(applicationId);
    },
  };
}

/** Read the protocol error `code` from a failed response, tolerating a missing or invalid body. */
async function codeOf(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.clone().json();
    if (typeof body === 'object' && body !== null && 'code' in body) {
      const { code } = body;
      return typeof code === 'string' ? code : null;
    }
  } catch {
    // A body-less or non-JSON 503 is treated as a generic 5xx by the caller.
  }
  return null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
