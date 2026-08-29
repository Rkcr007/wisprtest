import { CrawlBounds } from 'protocol';

import { BoundsError } from '../errors.js';

/**
 * Crawl bounds for a file dump.
 *
 * Every field is required by the contract — an unbounded crawl cannot be requested. These
 * defaults are sized for a first pass over a live app on a developer machine: shallow, capped,
 * and throttled. They are not application knowledge. Destructive selectors stay empty unless
 * the caller names them; the crawler already refuses form submitters on its own.
 */

export interface DumpBoundsInput {
  readonly origin: string;
  readonly maxDepth?: number;
  readonly maxPages?: number;
  readonly requestsPerMinute?: number;
  readonly neverInteractSelectors?: readonly string[];
}

/** Build contract-valid {@link CrawlBounds} for one origin. */
export function dumpBounds(input: DumpBoundsInput): CrawlBounds {
  const candidate = {
    allowedOrigins: [input.origin],
    routeAllowlist: ['/'],
    maxDepth: input.maxDepth ?? 2,
    maxPages: input.maxPages ?? 25,
    neverInteractSelectors: [...(input.neverInteractSelectors ?? [])],
    maxInteractionsPerRoute: 8,
    interactionObserveMs: 800,
    settleDelayMs: 150,
    networkIdleTimeoutMs: 8_000,
    navigationTimeoutMs: 20_000,
    requestsPerMinute: input.requestsPerMinute ?? 60,
    viewport: { width: 1280, height: 720 },
  };
  const parsed = CrawlBounds.safeParse(candidate);
  if (!parsed.success) {
    throw new BoundsError(
      parsed.error.issues.map((issue) => {
        const path = issue.path.length === 0 ? 'root' : issue.path.join('.');
        return `${path}: ${issue.message}`;
      }),
    );
  }
  return parsed.data;
}
