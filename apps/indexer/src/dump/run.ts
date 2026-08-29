import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';

import type { CrawlBounds, CrawlSkipReason, MemorySnapshot } from 'protocol';

import { launchBrowser, openSession } from '../crawl/browser.js';
import {
  crawl,
  type CrawlHandlers,
  type CrawlSummary,
  type IndexedScreen,
  type ObservedEdge,
} from '../crawl/crawler.js';
import { createRateLimiter } from '../crawl/rate-limiter.js';
import { createUrlPolicy, type AddressLookup } from '../crawl/url-policy.js';
import { assembleSnapshot, type AssembledScreen } from './assemble.js';

/**
 * Run the shipping crawler against one URL and return a contract-valid snapshot.
 *
 * No Postgres, no Redis, no job stream. The crawl itself is the same function the worker
 * runs; only the handlers write into memory instead of a tenant-scoped transaction.
 */

export interface DumpRunOptions {
  readonly baseUrl: string;
  readonly bounds: CrawlBounds;
  readonly tenantId?: string;
  readonly applicationId?: string;
  readonly memoryVersionId?: string;
  readonly generatedAt?: string;
  readonly idGen?: () => string;
  readonly addressLookup?: AddressLookup;
  readonly signal?: AbortSignal;
  /** Opt in so a VPN/Tailscale staging host is crawlable. Job-runner crawls stay closed. */
  readonly allowPrivateOnAllowlist?: boolean;
}

export interface DumpSkip {
  readonly path: string;
  readonly reason: CrawlSkipReason;
}

export interface DumpResult {
  readonly snapshot: MemorySnapshot;
  readonly summary: CrawlSummary;
  readonly skips: readonly DumpSkip[];
}

const defaultLookup: AddressLookup = async (hostname) => {
  const results = await lookup(hostname, { all: true });
  return results.map((entry) => entry.address);
};

/** Crawl `baseUrl` and assemble a snapshot. */
export async function dumpApplication(options: DumpRunOptions): Promise<DumpResult> {
  const idGen = options.idGen ?? randomUUID;
  const tenantId = options.tenantId ?? idGen();
  const applicationId = options.applicationId ?? idGen();
  const memoryVersionId = options.memoryVersionId ?? idGen();
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const lookupFn = options.addressLookup ?? defaultLookup;
  const owned = options.signal === undefined ? new AbortController() : undefined;
  const signal = options.signal ?? owned?.signal;
  if (signal === undefined) throw new Error('dump crawl has no abort signal');

  const screens: AssembledScreen[] = [];
  const edges: ObservedEdge[] = [];
  const skips: DumpSkip[] = [];

  const handlers: CrawlHandlers = {
    screenIndexed(screen: IndexedScreen): Promise<string> {
      const id = idGen();
      const elementIds = new Map<string, string>();
      for (const element of screen.elements) {
        elementIds.set(element.elementKey, idGen());
      }
      screens.push({ id, indexed: screen, elementIds });
      return Promise.resolve(id);
    },
    edgeObserved(edge: ObservedEdge): Promise<void> {
      edges.push(edge);
      return Promise.resolve();
    },
    async routeStarted(): Promise<void> {
      await Promise.resolve();
    },
    routeSkipped(path, reason): Promise<void> {
      skips.push({ path, reason });
      return Promise.resolve();
    },
    async checkpoint(): Promise<void> {
      await Promise.resolve();
    },
  };

  const browser = await launchBrowser(true);
  try {
    const session = await openSession({
      browser,
      bounds: options.bounds,
      auth: {},
    });
    try {
      const summary = await crawl({
        page: session.page,
        bounds: options.bounds,
        baseUrl: options.baseUrl,
        policy: createUrlPolicy(options.bounds, lookupFn, {
          ...(options.allowPrivateOnAllowlist === true ? { allowPrivateOnAllowlist: true } : {}),
        }),
        limiter: createRateLimiter(options.bounds.requestsPerMinute),
        handlers,
        alreadyIndexed: new Map(),
        signal,
      });

      const snapshot = assembleSnapshot({
        tenantId,
        applicationId,
        memoryVersionId,
        generatedAt,
        screens,
        edges,
        idGen,
      });

      return { snapshot, summary, skips };
    } finally {
      await session.close();
    }
  } finally {
    await browser.close();
    owned?.abort();
  }
}
