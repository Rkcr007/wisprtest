import { Redis } from 'ioredis';

import type { IndexerConfig } from '../config.js';

/**
 * The Redis connection, and the key namespace every command goes through.
 *
 * CLAUDE.md rule #7 requires every cache key to be namespaced. The gateway gets that from
 * ioredis's `keyPrefix` option; this service cannot, and the reason is worth writing down because
 * the failure it produces is silent:
 *
 * **`keyPrefix` is applied per command, from ioredis's key-position metadata, and that metadata
 * does not cover `XGROUP`.** `XADD` on `indexer:jobs` writes `wispr:indexer:jobs`, while
 * `XGROUP CREATE indexer:jobs` creates the group on `indexer:jobs` — a different key. The result
 * is a consumer group attached to an empty stream, a worker that reports `NOGROUP` forever, and a
 * queue that fills up next to it. Nothing errors at the point of the mistake.
 *
 * So the prefix is applied here, in code, by {@link namespacedKey}, and every key this service
 * touches is built through it. One rule, every command, no per-command metadata to trust.
 *
 * Streams also need their own connection semantics: `XREADGROUP BLOCK` occupies a connection for
 * the duration of the block, which is why the worker's loop and the health probe are the only
 * things sharing this client and why neither issues long blocking reads of its own.
 */

export const KEY_NAMESPACE = 'wispr';

export function createRedis(config: IndexerConfig): Redis {
  return new Redis(config.REDIS_URL, {
    // Unlike the gateway, the worker should wait out a Redis that is briefly unavailable rather
    // than fail a command: there is no user waiting on a response, and dropping a crawl because
    // of a two-second failover would waste minutes of browsing.
    enableOfflineQueue: true,
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
}

/** A key inside this deployment's namespace. */
export function namespacedKey(...parts: readonly string[]): string {
  return [KEY_NAMESPACE, ...parts].join(':');
}

/** A namespaced key scoped to one tenant. Every per-tenant key this service writes uses it. */
export function tenantKey(tenantId: string, ...parts: readonly string[]): string {
  return namespacedKey(`tenant:${tenantId}`, ...parts);
}
