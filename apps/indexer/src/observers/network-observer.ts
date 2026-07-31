import { createHash } from 'node:crypto';

import { pathOf, toRoutePattern } from 'fingerprint';
import type { Page, Response } from 'playwright';

import type { ObservedExchange } from './types.js';

/**
 * The network observer: what the application asked its own backend for, while we watched.
 *
 * The crawl never submits anything, so every request recorded here is one the application made
 * on its own — hydrating a table, filling a picker, pricing a form. That constraint is not a
 * limitation to work around, it is the reason this channel is safe to run against a customer's
 * staging environment at all.
 *
 * ## What is recorded, and what is refused
 *
 * JSON only, same-origin only, bounded in body size and in count. A crawl of an application with
 * an analytics beacon on every route would otherwise accumulate thousands of exchanges that
 * describe nothing, and holding a customer's response bodies in memory is a liability measured
 * in megabytes per route.
 *
 * ## Deduplication, and why it changes the numbers
 *
 * Edge observation reloads a route once per candidate control, so a single `GET /api/v2/orders`
 * is genuinely issued a dozen times per crawl with a byte-identical response. Recording each
 * would give the distributions a sample size twelve times the number of records that exist, and
 * a sample size that overstates the evidence is worse than no sample size at all — it is the
 * number `DerivedRule.confidence` is computed from. Identical exchanges collapse to one.
 *
 * ## PII
 *
 * Bodies live in this process's memory for the duration of one crawl job and are never written
 * anywhere. What survives is what `distributions.ts` and `derived-rules.ts` compute from them:
 * aggregates. Nothing here persists, logs, or transmits a response body.
 */

/** Bodies larger than this are a report or an export, not a collection worth learning from. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** A ceiling on what one job will hold in memory, whatever the application does. */
const MAX_EXCHANGES = 400;

export interface NetworkObserver {
  /** Start recording. Safe to call once per crawl session. */
  attach(page: Page): void;
  /** Stop recording and wait for bodies already in flight. Call before the context closes. */
  settle(): Promise<void>;
  /** Everything recorded, deduplicated, in observation order. */
  exchanges(): readonly ObservedExchange[];
}

export interface NetworkObserverOptions {
  /** Origins whose traffic is recorded. Everything else — CDNs, analytics — is ignored. */
  readonly allowedOrigins: readonly string[];
  /** Reported when a body could not be read. Not a crawl failure; most such bodies are images. */
  readonly onSkipped?: (reason: string) => void;
}

function isJson(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const type = contentType.toLowerCase();
  return type.includes('application/json') || type.includes('+json');
}

/**
 * Headers, or an empty set when they can no longer be read.
 *
 * Written as a function with an explicit return type rather than a `.catch(() => ({}))` so that
 * the empty case is a `Record<string, string>` in its own right. Inline, the two branches widen
 * to a union with `{}`, which is not indexable.
 */
async function headersOf(source: {
  allHeaders(): Promise<Record<string, string>>;
}): Promise<Record<string, string>> {
  try {
    return await source.allHeaders();
  } catch {
    return {};
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Stable identity of an exchange: same call, same answer. */
function fingerprintExchange(
  method: string,
  path: string,
  requestBody: unknown,
  responseBody: unknown,
): string {
  return createHash('sha256')
    .update(method)
    .update('\0')
    .update(path)
    .update('\0')
    .update(JSON.stringify(requestBody ?? null))
    .update('\0')
    .update(JSON.stringify(responseBody ?? null))
    .digest('hex');
}

export function createNetworkObserver(options: NetworkObserverOptions): NetworkObserver {
  const origins = new Set(
    options.allowedOrigins.map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        return origin;
      }
    }),
  );

  const recorded: ObservedExchange[] = [];
  const seen = new Set<string>();
  const pending = new Set<Promise<void>>();

  let attachedTo: Page | undefined;
  let stopped = false;

  const skip = (reason: string): void => options.onSkipped?.(reason);

  async function record(response: Response): Promise<void> {
    if (stopped || recorded.length >= MAX_EXCHANGES) return;

    const request = response.request();
    const url = new URL(request.url());
    if (!origins.has(url.origin)) return;

    // A redirect has no body of its own, and asking for one throws rather than returning empty.
    if (response.status() >= 300 && response.status() < 400) return;

    const headers = await headersOf(response);
    if (!isJson(headers['content-type'])) return;

    const length = Number(headers['content-length'] ?? '0');
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      skip(`response body over ${String(MAX_BODY_BYTES)} bytes`);
      return;
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      // The page navigated away before the body arrived. Ordinary during edge observation.
      skip('response body was no longer available');
      return;
    }
    if (text.length > MAX_BODY_BYTES) {
      skip(`response body over ${String(MAX_BODY_BYTES)} bytes`);
      return;
    }

    const responseBody = parseJson(text);
    if (responseBody === null) return;

    const postData = request.postData();
    const requestBody = postData === null ? null : parseJson(postData);

    const requestHeaders = await headersOf(request);

    const path = pathOf(url.pathname);
    const identity = fingerprintExchange(request.method(), url.pathname, requestBody, responseBody);
    if (seen.has(identity)) return;
    seen.add(identity);

    recorded.push({
      method: request.method().toUpperCase(),
      path,
      routePattern: toRoutePattern(url.href),
      status: response.status(),
      requestBody,
      responseBody,
      // Presence only. The credential itself is never read, let alone kept.
      auth:
        requestHeaders.authorization === undefined
          ? requestHeaders.cookie === undefined
            ? 'none'
            : 'session'
          : 'bearer',
    });
  }

  const listener = (response: Response): void => {
    // Playwright does not await event handlers, so the promise is tracked here instead: a body
    // still being read when the crawl finishes would otherwise be lost, and losing the list
    // response is losing every distribution.
    const task = record(response).catch(() => {
      skip('response could not be recorded');
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  return {
    attach(page: Page): void {
      attachedTo = page;
      page.on('response', listener);
    },

    async settle(): Promise<void> {
      stopped = true;
      attachedTo?.off('response', listener);
      attachedTo = undefined;
      await Promise.allSettled([...pending]);
    },

    exchanges(): readonly ObservedExchange[] {
      return recorded;
    },
  };
}
