import { AliasWritebackResult, type AliasWriteback } from 'protocol';

/**
 * The alias write-back client, in the service worker.
 *
 * `POST /v1/memory/aliases`, batched. It is the last hop of the compounding loop
 * (docs/ARCHITECTURE.md § 6): a phrase that cost a T2 escalation once is persisted here, and the
 * next snapshot carries it as an alias that resolves at T0 without leaving the device.
 *
 * ## Why this one rejects
 *
 * Unlike the escalation client — which reports failures so a resolution can fall back — a failed
 * write-back is worth *retrying*, and the queue that calls this is the thing that decides when.
 * So the failure is thrown and the queue re-holds the batch, rather than being swallowed here
 * where nothing knows what to do with it. Nothing on the hot path is waiting either way: the
 * extension already resolved the phrase, this is only teaching the control plane about it.
 */

/** The route this client calls. */
export const ALIASES_PATH = '/v1/memory/aliases';

export class AliasWritebackFailed extends Error {
  /** True when another attempt could plausibly succeed — a 5xx, a 429, or a dead connection. */
  readonly retryable: boolean;

  constructor(detail: string, retryable: boolean) {
    super(`alias write-back failed: ${detail}`);
    this.name = 'AliasWritebackFailed';
    this.retryable = retryable;
  }
}

export interface AliasClientOptions {
  /** Origin of the control plane. Must match the manifest's `host_permissions`. */
  readonly gatewayOrigin: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface AliasClient {
  /** Persist one batch against a memory version. Throws {@link AliasWritebackFailed} on failure. */
  write(
    memoryVersionId: string,
    items: readonly AliasWriteback[],
    bearerToken: string,
  ): Promise<AliasWritebackResult>;
}

export function createAliasClient(options: AliasClientOptions): AliasClient {
  const { gatewayOrigin, fetch: fetchImpl = globalThis.fetch.bind(globalThis) } = options;
  const endpoint = new URL(ALIASES_PATH, gatewayOrigin).href;

  return {
    async write(memoryVersionId, items, bearerToken): Promise<AliasWritebackResult> {
      if (items.length === 0) {
        // The contract requires a non-empty batch: "an empty batch is a bug, not a no-op".
        throw new AliasWritebackFailed('empty batch', false);
      }

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${bearerToken}`,
          },
          body: JSON.stringify({ memoryVersionId, items }),
        });
      } catch (error: unknown) {
        throw new AliasWritebackFailed(
          error instanceof Error ? error.message : 'network error',
          true,
        );
      }

      if (!response.ok) {
        // A 4xx will fail identically forever — a rejected batch, a version that is not this
        // tenant's — so it is not retried; the queue drops it rather than looping on it.
        throw new AliasWritebackFailed(
          `HTTP ${String(response.status)}`,
          response.status >= 500 || response.status === 429,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error: unknown) {
        throw new AliasWritebackFailed(
          error instanceof Error ? error.message : 'invalid JSON',
          false,
        );
      }

      const parsed = AliasWritebackResult.safeParse(payload);
      if (!parsed.success) throw new AliasWritebackFailed('malformed result', false);
      return parsed.data;
    },
  };
}
