import { pathOf, screenLabel, toRoutePattern } from 'fingerprint';
import type { Page, Response } from 'playwright';
import type { CrawlBounds, CrawlSkipReason, ElementFingerprint } from 'protocol';

import { CancelledError, NavigationError } from '../errors.js';
import type {
  CollectedElement,
  CollectedFormRegion,
  CollectedPage,
  CollectOptions,
} from './collected.js';
import { ElementKeyMinter } from './element-key.js';
import { BUNDLE_GLOBAL, MARKER_ATTRIBUTE } from './fingerprint-bundle.js';
import type { RateLimiter } from './rate-limiter.js';
import type { UrlPolicy } from './url-policy.js';

/**
 * The crawl: breadth-first, bounded, and incapable of committing anything.
 *
 * ## Order of work per route
 *
 * navigate → settle → collect → persist → discover links → observe nav edges. Persisting before
 * observing edges is what makes the crawl resumable at route granularity: a crash during edge
 * observation loses the edges from one screen, never the screen.
 *
 * ## Breadth first, not depth first
 *
 * A depth-first crawl of an application with a "next" link walks a thousand pages of one table
 * before it sees the second nav item. Breadth-first spends the page budget on the *variety* of
 * screens, which is what memory is for.
 *
 * ## Why edges are observed rather than read off the markup
 *
 * `href` says where a link points; it does not say what clicking it does. Applications intercept
 * clicks, guard routes, open dialogs instead of navigating, and redirect. ARCHITECTURE § 5 says
 * to derive edges by "observing which element click produced which route transition", and that is
 * what happens here — with the clicking restricted to what cannot commit state.
 */

/** One element as it will be written to memory. */
export interface IndexedElement {
  readonly elementKey: string;
  readonly fingerprint: ElementFingerprint;
  readonly confidence: number;
}

/** One screen, ready to persist. */
export interface IndexedScreen {
  readonly url: string;
  readonly routePattern: string;
  readonly stateFingerprint: string;
  readonly structuralHash: string;
  readonly label: string;
  readonly elements: readonly IndexedElement[];
}

/** A transition observed during the crawl, in terms the persistence layer can resolve. */
export interface ObservedEdge {
  readonly fromScreenId: string;
  readonly fromRoutePattern: string;
  readonly toScreenId: string;
  readonly triggerElementKey: string;
  readonly confidence: number;
}

/**
 * The forms found on one route, with the element keys their controls were given.
 *
 * Emitted while the page is still on the route, because the marker attributes that connect a
 * control to its element key exist only in that document. `elementKeys` is indexed by marker.
 */
export interface ObservedFormRegions {
  readonly routePattern: string;
  readonly elementKeys: readonly string[];
  readonly regions: readonly CollectedFormRegion[];
}

export interface CrawlHandlers {
  /** Persist one screen and its elements; returns the screen's id. */
  screenIndexed(screen: IndexedScreen): Promise<string>;
  /**
   * Receive the forms on a newly indexed route.
   *
   * Optional: a crawl that only wants a navigation map is a complete crawl, and schema
   * observation is a separate concern that happens to need the same page load.
   */
  formsObserved?(observation: ObservedFormRegions): Promise<void>;
  /** Persist one observed transition. Called after both endpoints exist. */
  edgeObserved(edge: ObservedEdge): Promise<void>;
  routeStarted(path: string, depth: number): Promise<void>;
  routeSkipped(path: string, reason: CrawlSkipReason): Promise<void>;
  /** Record progress so a crash resumes from here rather than from the base URL. */
  checkpoint(frontier: readonly FrontierEntry[], visited: readonly string[]): Promise<void>;
}

export interface FrontierEntry {
  readonly url: string;
  readonly depth: number;
}

export interface CrawlOptions {
  readonly page: Page;
  readonly bounds: CrawlBounds;
  readonly baseUrl: string;
  readonly policy: UrlPolicy;
  readonly limiter: RateLimiter;
  readonly handlers: CrawlHandlers;
  /** Screens already written under this memory version, by state fingerprint. Resume state. */
  readonly alreadyIndexed: ReadonlyMap<string, string>;
  /** Frontier and visited set from a checkpoint, when resuming. */
  readonly resumeFrom?: {
    readonly frontier: readonly FrontierEntry[];
    readonly visited: readonly string[];
  };
  /** Aborted when the worker is shutting down; the crawl stops between routes, never mid-write. */
  readonly signal: AbortSignal;
}

export interface CrawlSummary {
  readonly screensIndexed: number;
  readonly elementsIndexed: number;
  readonly edgesObserved: number;
  readonly routesSkipped: number;
}

export async function crawl(options: CrawlOptions): Promise<CrawlSummary> {
  const { page, bounds, policy, limiter, handlers, signal } = options;

  const frontier: FrontierEntry[] = [
    ...(options.resumeFrom?.frontier ?? [{ url: options.baseUrl, depth: 0 }]),
  ];
  const visited = new Set(options.resumeFrom?.visited ?? []);
  /** Screen id by canonical URL, so an edge's target can be resolved once it has been indexed. */
  const screenByUrl = new Map<string, string>();
  /** State fingerprints already written, from this run and from the resumed version. */
  const indexedFingerprints = new Map(options.alreadyIndexed);
  const pendingEdges: PendingEdge[] = [];
  /** Canonical URLs already reported as skipped at discovery, so a link on ten pages says so once. */
  const reportedSkips = new Set<string>();

  let screensIndexed = 0;
  let elementsIndexed = 0;
  let routesSkipped = 0;

  while (frontier.length > 0) {
    if (signal.aborted) throw new CancelledError('worker is shutting down');
    if (indexedFingerprints.size >= bounds.maxPages) {
      // The cap counts every screen in this memory version, including those a previous attempt at
      // the same job wrote before it died — otherwise a job that crashed near the cap would
      // resume and index another `maxPages` on top.
      for (const remaining of frontier) {
        await handlers.routeSkipped(pathOf(remaining.url), 'page_cap_reached');
        routesSkipped += 1;
      }
      break;
    }

    const entry = frontier.shift();
    if (entry === undefined) break;

    const canonical = canonicalize(entry.url);
    if (visited.has(canonical)) continue;
    visited.add(canonical);

    const outcome = await visitRoute({
      entry,
      page,
      bounds,
      policy,
      limiter,
      handlers,
      signal,
      indexedFingerprints,
    });

    if (outcome.kind === 'skipped') {
      routesSkipped += 1;
      await handlers.checkpoint(frontier, [...visited]);
      continue;
    }

    screenByUrl.set(canonical, outcome.screenId);
    screenByUrl.set(canonicalize(outcome.collected.url), outcome.screenId);
    if (outcome.indexed) {
      screensIndexed += 1;
      elementsIndexed += outcome.elementCount;
      indexedFingerprints.set(outcome.stateFingerprint, outcome.screenId);
    }

    // Links first, so the frontier grows even if edge observation is cut short by the page cap.
    for (const link of outcome.collected.links) {
      const target = canonicalize(link);
      if (visited.has(target) || frontier.some((queued) => canonicalize(queued.url) === target)) {
        continue;
      }

      // A link the crawl will not follow is *reported* rather than dropped quietly. An
      // application that looks half-indexed should say which links it declined and why —
      // otherwise a misconfigured allowlist is indistinguishable from a small application.
      if (entry.depth + 1 > bounds.maxDepth) {
        if (!reportedSkips.has(target)) {
          reportedSkips.add(target);
          await handlers.routeSkipped(pathOf(link), 'depth_exceeded');
          routesSkipped += 1;
        }
        continue;
      }
      if (!(await policy.isAllowed(link))) {
        if (!reportedSkips.has(target)) {
          reportedSkips.add(target);
          await handlers.routeSkipped(pathOf(link), 'off_allowlist');
          routesSkipped += 1;
        }
        continue;
      }

      frontier.push({ url: link, depth: entry.depth + 1 });
    }

    const observed = await observeEdges({
      page,
      bounds,
      policy,
      limiter,
      signal,
      sourceUrl: outcome.collected.url,
      screenId: outcome.screenId,
      routePattern: outcome.routePattern,
      elements: outcome.collected.elements,
      elementKeys: outcome.elementKeys,
    });

    for (const edge of observed) {
      pendingEdges.push(edge);
      const target = canonicalize(edge.targetUrl);
      if (
        !visited.has(target) &&
        entry.depth + 1 <= bounds.maxDepth &&
        !frontier.some((queued) => canonicalize(queued.url) === target)
      ) {
        frontier.push({ url: edge.targetUrl, depth: entry.depth + 1 });
      }
    }

    await handlers.checkpoint(frontier, [...visited]);
  }

  // Edges are written last because a transition's target is frequently indexed after its source.
  // An edge whose target never got indexed — the page cap cut the crawl short, or the target was
  // outside the allowlist — is dropped rather than written against a screen that does not exist.
  let edgesObserved = 0;
  for (const edge of pendingEdges) {
    const toScreenId = screenByUrl.get(canonicalize(edge.targetUrl));
    if (toScreenId === undefined) continue;

    await handlers.edgeObserved({
      fromScreenId: edge.fromScreenId,
      fromRoutePattern: edge.fromRoutePattern,
      toScreenId,
      triggerElementKey: edge.triggerElementKey,
      confidence: edge.confidence,
    });
    edgesObserved += 1;
  }

  return { screensIndexed, elementsIndexed, edgesObserved, routesSkipped };
}

interface PendingEdge {
  readonly fromScreenId: string;
  readonly fromRoutePattern: string;
  readonly triggerElementKey: string;
  readonly targetUrl: string;
  readonly confidence: number;
}

type VisitOutcome =
  | { readonly kind: 'skipped'; readonly reason: CrawlSkipReason }
  | {
      readonly kind: 'visited';
      readonly screenId: string;
      readonly stateFingerprint: string;
      readonly routePattern: string;
      readonly collected: CollectedPage;
      readonly elementKeys: readonly string[];
      readonly elementCount: number;
      /** False when this state was already in memory and only its links were harvested. */
      readonly indexed: boolean;
    };

interface VisitOptions {
  readonly entry: FrontierEntry;
  readonly page: Page;
  readonly bounds: CrawlBounds;
  readonly policy: UrlPolicy;
  readonly limiter: RateLimiter;
  readonly handlers: CrawlHandlers;
  readonly signal: AbortSignal;
  readonly indexedFingerprints: ReadonlyMap<string, string>;
}

async function visitRoute(options: VisitOptions): Promise<VisitOutcome> {
  const { entry, page, bounds, policy, limiter, handlers } = options;
  const path = pathOf(entry.url);

  await handlers.routeStarted(path, entry.depth);

  // Every navigation is checked, including ones that came from a link on a page we trusted.
  try {
    await policy.assertAllowed(entry.url);
  } catch {
    await handlers.routeSkipped(path, 'ssrf_rejected');
    return { kind: 'skipped', reason: 'ssrf_rejected' };
  }

  await limiter.acquire();

  let response: Response | null;
  try {
    response = await page.goto(entry.url, {
      waitUntil: 'domcontentloaded',
      timeout: bounds.navigationTimeoutMs,
    });
  } catch {
    await handlers.routeSkipped(path, 'navigation_failed');
    return { kind: 'skipped', reason: 'navigation_failed' };
  }

  if (response !== null && !response.ok()) {
    await handlers.routeSkipped(path, 'navigation_failed');
    return { kind: 'skipped', reason: 'navigation_failed' };
  }

  const contentType = response?.headers()['content-type'] ?? 'text/html';
  if (!contentType.includes('html')) {
    // A PDF or a CSV export is a perfectly good link and not a screen. Indexing it would produce
    // a screen with no elements and a structural hash of nothing.
    await handlers.routeSkipped(path, 'non_html_content');
    return { kind: 'skipped', reason: 'non_html_content' };
  }

  // Redirects are followed by the browser, so the URL that was checked may not be the one that
  // loaded. Re-checking here is what stops an open redirect from being a way past the allowlist.
  try {
    await policy.assertAllowed(page.url());
  } catch {
    await handlers.routeSkipped(path, 'ssrf_rejected');
    return { kind: 'skipped', reason: 'ssrf_rejected' };
  }

  await settle(page, bounds);

  const routePattern = toRoutePattern(page.url());
  const collectOptions: CollectOptions = {
    routePattern,
    neverInteractSelectors: bounds.neverInteractSelectors,
    viewport: bounds.viewport,
    markerAttribute: MARKER_ATTRIBUTE,
  };
  const collected = await collectPage(page, collectOptions);

  // Minted before the already-indexed check because forms are observed either way, and a form's
  // controls are named by the keys of the elements that edit them. Minting is pure computation
  // over what was already collected — no navigation, no database.
  const { elements, elementKeys } = describeElements(collected, routePattern);

  /**
   * Hand this route's forms to the observer, while the page is still on it.
   *
   * Runs even when the screen was already in memory. A resumed crawl re-walks routes a previous
   * attempt indexed, and a run that declined to re-read their forms would consolidate a *smaller*
   * schema than the one it is continuing — losing the requiredness, the validation limits and the
   * UI materializer that only a form can supply.
   *
   * The markers it reads belong to the document that is loaded right now, and edge observation is
   * about to replace that document repeatedly, so this cannot be deferred.
   */
  const observePageForms = async (): Promise<void> => {
    if (handlers.formsObserved === undefined) return;
    await handlers.formsObserved({
      routePattern,
      elementKeys,
      regions: await collectFormRegions(page, collectOptions),
    });
  };

  const existing = options.indexedFingerprints.get(collected.stateFingerprint);
  if (existing !== undefined) {
    // The same reachable state under a different URL — `/orders/1841` and `/orders/1842` are one
    // screen. Its links still matter, because they may reach states nothing else links to.
    await handlers.routeSkipped(path, 'already_indexed');
    await observePageForms();
    return {
      kind: 'visited',
      screenId: existing,
      stateFingerprint: collected.stateFingerprint,
      routePattern,
      collected,
      // Empty on purpose, so edge observation does not re-click a screen whose edges are already
      // recorded. Form observation above took the keys it needed directly.
      elementKeys: [],
      elementCount: 0,
      indexed: false,
    };
  }

  const screenId = await handlers.screenIndexed({
    url: collected.url,
    routePattern,
    stateFingerprint: collected.stateFingerprint,
    structuralHash: collected.structuralHash,
    label: screenLabel(routePattern),
    elements,
  });

  await observePageForms();

  return {
    kind: 'visited',
    screenId,
    stateFingerprint: collected.stateFingerprint,
    routePattern,
    collected,
    elementKeys,
    elementCount: elements.length,
    indexed: true,
  };
}

/**
 * Wait for the page to stop changing.
 *
 * Network idle, then a fixed settle delay. The delay is not redundant: idle means no requests are
 * in flight, and a framework that has just received its data still has to render it. Both are
 * bounded and both failing to arrive is normal — an application with a websocket or a polling
 * timer never reaches network idle at all, and waiting past the timeout would stall the crawl on
 * every route rather than indexing a page that is, in fact, ready.
 */
async function settle(page: Page, bounds: CrawlBounds): Promise<void> {
  await page
    .waitForLoadState('networkidle', { timeout: bounds.networkIdleTimeoutMs })
    .catch(() => undefined);
  await page.waitForTimeout(bounds.settleDelayMs);
}

/**
 * The shape the injected bundle installs on the page's global object.
 *
 * The global's *name* is passed in as an argument rather than referenced from this module's
 * scope: `page.evaluate` serialises the function and runs it in the page, where nothing this file
 * closes over exists. A constant referenced directly here would be a `ReferenceError` in the
 * browser and a mystifying one to debug.
 */
interface InPageApi {
  collect(options: CollectOptions): CollectedPage;
  collectForms(options: CollectOptions): CollectedFormRegion[];
  stamp(options: { markerAttribute: string }): number;
}

/** Run the injected collector in the page. */
async function collectPage(page: Page, options: CollectOptions): Promise<CollectedPage> {
  try {
    return await page.evaluate<CollectedPage, { globalName: string; options: CollectOptions }>(
      ({ globalName, options: collectOptions }) => {
        const api = (globalThis as unknown as Record<string, InPageApi | undefined>)[globalName];
        if (api === undefined) throw new Error('the WisprTest collector was not injected');
        return api.collect(collectOptions);
      },
      { globalName: BUNDLE_GLOBAL, options },
    );
  } catch (error: unknown) {
    throw new NavigationError(page.url(), `in-page collection failed: ${describe(error)}`, {
      cause: error,
    });
  }
}

/**
 * Run the injected form collector in the page.
 *
 * Called after {@link collectPage}, never before: the markers it reads off each control are
 * stamped by the collection pass, and without them a field cannot be connected to the element
 * key that the UI materializer will resolve it by.
 *
 * A failure here is not a crawl failure. The screen has already been persisted, and an
 * application whose forms cannot be read is one that yields no schema — which is a gap in what
 * was learned, not a reason to discard a navigation map that is already correct.
 */
async function collectFormRegions(
  page: Page,
  options: CollectOptions,
): Promise<CollectedFormRegion[]> {
  try {
    return await page.evaluate<
      CollectedFormRegion[],
      { globalName: string; options: CollectOptions }
    >(
      ({ globalName, options: collectOptions }) => {
        const api = (globalThis as unknown as Record<string, InPageApi | undefined>)[globalName];
        if (api === undefined) throw new Error('the WisprTest collector was not injected');
        return api.collectForms(collectOptions);
      },
      { globalName: BUNDLE_GLOBAL, options },
    );
  } catch {
    return [];
  }
}

/** Re-apply markers after a navigation destroyed them. Returns how many were stamped. */
async function stampMarkers(page: Page): Promise<number> {
  return page.evaluate<number, { globalName: string; markerAttribute: string }>(
    ({ globalName, markerAttribute }) => {
      const api = (globalThis as unknown as Record<string, InPageApi | undefined>)[globalName];
      if (api === undefined) throw new Error('the WisprTest collector was not injected');
      return api.stamp({ markerAttribute });
    },
    { globalName: BUNDLE_GLOBAL, markerAttribute: MARKER_ATTRIBUTE },
  );
}

/**
 * Turn collected fingerprints into elements with keys and confidence.
 *
 * Confidence answers one question: how sure is the indexer that this fingerprint identifies this
 * element *uniquely on this screen*? It is derived, not assumed:
 *
 * - Elements sharing a role, an accessible name and a landmark path are genuinely ambiguous, and
 *   each takes a proportional share of the confidence. Ten identical "View" links score 0.1 —
 *   which is correct, and which is why the resolver escalates to an ordinal rather than guessing.
 * - A stable attribute that is unique on the screen settles it: `data-testid` is "near-decisive"
 *   in ARCHITECTURE § 2, and an element carrying a unique one is unambiguous whatever else it
 *   shares.
 * - An element with neither a name nor a stable attribute is capped: it is identified only by
 *   position and role, which is the weak end of the signal table.
 */
function describeElements(
  collected: CollectedPage,
  routePattern: string,
): { elements: IndexedElement[]; elementKeys: string[] } {
  const minter = new ElementKeyMinter(routePattern);

  const identityCounts = new Map<string, number>();
  const attributeCounts = new Map<string, number>();
  for (const element of collected.elements) {
    const identity = identityOf(element.fingerprint);
    identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
    for (const attribute of stableAttributePairs(element.fingerprint)) {
      attributeCounts.set(attribute, (attributeCounts.get(attribute) ?? 0) + 1);
    }
  }

  const elements: IndexedElement[] = [];
  const elementKeys: string[] = [];

  for (const element of collected.elements) {
    const key = minter.mint(element.fingerprint);
    elementKeys.push(key);
    elements.push({
      elementKey: key,
      fingerprint: element.fingerprint,
      confidence: confidenceFor(element, identityCounts, attributeCounts),
    });
  }

  return { elements, elementKeys };
}

function confidenceFor(
  element: CollectedElement,
  identityCounts: ReadonlyMap<string, number>,
  attributeCounts: ReadonlyMap<string, number>,
): number {
  const { fingerprint } = element;

  const hasUniqueAttribute = stableAttributePairs(fingerprint).some(
    (attribute) => (attributeCounts.get(attribute) ?? 0) === 1,
  );
  if (hasUniqueAttribute) return 1;

  const duplicates = identityCounts.get(identityOf(fingerprint)) ?? 1;
  const shared = 1 / duplicates;

  const hasName = fingerprint.accessibleNameRedacted.trim() !== '';
  const ceiling = hasName ? 1 : 0.5;

  return round(Math.min(shared, ceiling));
}

/** What makes two elements interchangeable to a tester: same role, same name, same place. */
function identityOf(fingerprint: ElementFingerprint): string {
  return [
    fingerprint.role,
    fingerprint.accessibleNameHash,
    fingerprint.landmarkPath.join('>'),
  ].join('|');
}

function stableAttributePairs(fingerprint: ElementFingerprint): string[] {
  return Object.entries(fingerprint.stableAttributes).map(([name, value]) => `${name}=${value}`);
}

/** Two decimal places: `numeric` in Postgres, and a confidence of 0.3333… reads as false precision. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

interface ObserveOptions {
  readonly page: Page;
  readonly bounds: CrawlBounds;
  readonly policy: UrlPolicy;
  readonly limiter: RateLimiter;
  readonly signal: AbortSignal;
  readonly sourceUrl: string;
  readonly screenId: string;
  readonly routePattern: string;
  readonly elements: readonly CollectedElement[];
  readonly elementKeys: readonly string[];
}

/**
 * Click the safe candidates on a screen and record where they led.
 *
 * ## What is safe
 *
 * `interactable` was decided in the page, where the DOM is: the never-interact selectors, form
 * submitters, and disabled controls are all excluded there. This function adds the checks that
 * need the crawl's own context — a link whose target is outside the allowlist is not clicked at
 * all, rather than clicked and then rejected, because "navigate and then notice" is a request
 * that already happened.
 *
 * ## Restoring state
 *
 * After every click, the source route is loaded again and the markers re-stamped, because the
 * numbering has to be re-established before the next candidate can be addressed. A stamp count
 * that no longer matches means the page came back differently and the remaining markers cannot be
 * trusted, so observation stops for that screen rather than clicking something it has not
 * identified.
 */
async function observeEdges(options: ObserveOptions): Promise<PendingEdge[]> {
  const { page, bounds, policy, limiter, signal } = options;
  if (bounds.maxInteractionsPerRoute === 0) return [];

  const candidates = options.elements
    .map((element, index) => ({ element, key: options.elementKeys[index] }))
    .filter(
      (candidate): candidate is { element: CollectedElement; key: string } =>
        candidate.element.interactable && candidate.key !== undefined,
    )
    .slice(0, bounds.maxInteractionsPerRoute);

  const edges: PendingEdge[] = [];

  for (const candidate of candidates) {
    if (signal.aborted) break;

    // A link that points off the allowlist is never activated. Clicking first and checking after
    // would mean the request had already left.
    if (candidate.element.href !== null && !(await policy.isAllowed(candidate.element.href))) {
      continue;
    }

    await limiter.acquire();

    const before = page.url();
    const clicked = await clickMarker(page, candidate.element.marker, bounds.interactionObserveMs);

    if (clicked) {
      const after = await settleAfterClick(page, before, bounds);

      // A target outside the allowlist is observed but not recorded: an edge in memory is
      // something the runtime may later take, and it may not take that one.
      if (after !== null && (await policy.isAllowed(after))) {
        edges.push({
          fromScreenId: options.screenId,
          fromRoutePattern: options.routePattern,
          triggerElementKey: candidate.key,
          targetUrl: after,
          // Observed directly, once, on a deterministic page. Repeat observations across memory
          // versions are what will move this below 1 — see the drift phase.
          confidence: 1,
        });
      }
    }

    // Restored after *every* click, including ones that appeared to do nothing.
    //
    // A click can replace the document without changing the URL — a link to the page you are
    // already on, a form that posts and redirects back, a full reload. The URL is unchanged, so
    // nothing looks like it happened, but every marker attribute went with the old document and
    // each remaining candidate would silently fail to be found. Reloading unconditionally costs
    // one navigation per candidate and makes each one start from a state we have identified.
    if (!(await restore(page, options, bounds, limiter))) break;
  }

  return edges;
}

/** Click one marked element. False when it could not be clicked, which is not an error. */
async function clickMarker(page: Page, marker: number, observeMs: number): Promise<boolean> {
  try {
    await page.locator(`[${MARKER_ATTRIBUTE}="${String(marker)}"]`).click({ timeout: observeMs });
    return true;
  } catch {
    // Obscured by a sticky header, detached by a re-render, or animating. None of these are
    // failures of the crawl — the element simply was not clickable at that moment.
    return false;
  }
}

/**
 * The URL after a click, or null if it did not navigate.
 *
 * Both outcomes are ordinary: most controls on a screen open a menu, toggle a filter or focus a
 * field, and only some of them navigate. Waiting the full navigation timeout on every one would
 * make edge observation cost minutes per screen, so this waits only long enough to see a
 * transition begin.
 */
async function settleAfterClick(
  page: Page,
  before: string,
  bounds: CrawlBounds,
): Promise<string | null> {
  try {
    await page.waitForURL((url) => url.href !== before, {
      timeout: bounds.interactionObserveMs,
    });
  } catch {
    return null;
  }

  await settle(page, bounds);
  const after = page.url();
  return canonicalize(after) === canonicalize(before) ? null : after;
}

/**
 * Return to the screen being indexed and re-establish the markers.
 *
 * False when the screen cannot be reached again, or when it came back with a different number of
 * interactive elements. The second case is the important one: the markers address elements by
 * position in a walk of the document, so a screen that re-renders differently — a toast that is
 * still up, a list that loaded another row — invalidates every marker after the first difference.
 * Observation stops there rather than clicking something it has not identified.
 */
async function restore(
  page: Page,
  options: ObserveOptions,
  bounds: CrawlBounds,
  limiter: RateLimiter,
): Promise<boolean> {
  await limiter.acquire();
  try {
    await page.goto(options.sourceUrl, {
      waitUntil: 'domcontentloaded',
      timeout: bounds.navigationTimeoutMs,
    });
  } catch {
    return false;
  }
  await settle(page, bounds);

  try {
    return (await stampMarkers(page)) === options.elements.length;
  } catch {
    return false;
  }
}

/** Identity of a URL for visit tracking: origin and path, without the fragment or query. */
function canonicalize(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${pathOf(parsed.pathname)}`;
  } catch {
    return url;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : 'unknown error';
}
