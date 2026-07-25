import { Redis } from 'ioredis';

import type { GatewayConfig } from '../config.js';

/**
 * The Redis connection.
 *
 * CLAUDE.md rule #7 requires every cache key to be namespaced. `keyPrefix` applies it to every
 * command on this client, so a key written without thinking about tenancy still cannot collide
 * with another deployment sharing the instance — and the caller cannot forget, because there is
 * no unprefixed client to reach for.
 *
 * Tenant scoping *within* the namespace is the caller's business, and the helpers below make it
 * the obvious thing to write.
 */

export const KEY_NAMESPACE = 'wispr';

export function createRedis(config: GatewayConfig): Redis {
  return new Redis(config.REDIS_URL, {
    keyPrefix: `${KEY_NAMESPACE}:`,
    // Fail a command rather than queue it forever when the server is unreachable: a request
    // waiting on a dead Redis should return 503, not hang until the client gives up.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    // `lazyConnect` keeps construction synchronous; the readiness probe is what proves the
    // connection actually works, and boot should not block on a dependency that may be starting.
    lazyConnect: true,
  });
}

/** A tenant-scoped key. Every key the gateway writes goes through here. */
export function tenantKey(tenantId: string, ...parts: readonly string[]): string {
  return [`tenant:${tenantId}`, ...parts].join(':');
}
