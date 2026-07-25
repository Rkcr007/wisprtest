import { z } from 'zod';

import {
  Confidence,
  ElementKey,
  HttpUrl,
  IsoDateTime,
  LatencyMs,
  NonEmptyString,
  Ordinal,
  RoutePath,
  RoutePattern,
  StateFingerprint,
  Uuid,
} from './primitives.js';
import { contract } from './registry.js';

/**
 * Indexing — the crawl job the gateway enqueues and the progress the indexer streams back.
 *
 * Two process boundaries are described here. A `CrawlJob` travels gateway → Redis stream →
 * indexer; an `IndexProgressEvent` travels indexer → Redis stream → console. Both are in the
 * contract package for the reason CLAUDE.md rule #3 gives: they cross a process boundary, so
 * exactly one definition of them may exist.
 *
 * ## Credentials
 *
 * Nothing in this module can carry a credential. An {@link AuthProfile} holds a
 * {@link SecretRef} — a pointer the indexer resolves at the moment of use — and the resolved
 * value never returns to this contract, is never logged, and is never written to Postgres or
 * Redis. That is ARCHITECTURE § 8: "Credentials for the app under test — never stored by
 * WisprTest in plaintext."
 *
 * A Playwright `storageState` blob is treated as a credential too, and for the same reason: it
 * holds live session cookies and bearer tokens. It is referenced, never inlined.
 *
 * ## Bounds are not optional
 *
 * Every field of {@link CrawlBounds} is required and none has a default. A crawl that starts
 * without a page cap walks a customer's application until something falls over, and a crawl that
 * starts without a never-interact list can click Delete. Making the bounds a required part of the
 * job means an unbounded crawl fails schema validation before a browser is launched.
 */

/**
 * Where a secret lives. Two providers, both of which resolve to something the process can read
 * at the moment of use.
 *
 * `env` names an environment variable; `file` names a path. Between them they cover production
 * without a stub: Vault, AWS Secrets Manager and GCP Secret Manager are all consumed in
 * Kubernetes by projecting the secret into a file or an environment variable — via the Secrets
 * Store CSI driver or External Secrets — so a provider enum entry for each would name a code
 * path that does not exist and would not need to.
 */
export const SecretProvider = contract(
  'SecretProvider',
  z
    .enum(['env', 'file'])
    .describe('How a secret reference is resolved: an environment variable, or a file path.'),
);
export type SecretProvider = z.infer<typeof SecretProvider>;

/**
 * A pointer to a credential. Never the credential.
 *
 * This is the only form in which the application-under-test's login details cross a process
 * boundary. The resolved value has no representation anywhere in `packages/protocol`.
 */
export const SecretRef = contract(
  'SecretRef',
  z
    .strictObject({
      provider: SecretProvider,
      /** Variable name for `env`, absolute path for `file`. */
      key: NonEmptyString.describe('Environment variable name, or absolute file path.'),
    })
    .describe('Reference to a credential held outside WisprTest, resolved at the point of use.'),
);
export type SecretRef = z.infer<typeof SecretRef>;

/**
 * How the crawler authenticates against the application under test.
 *
 * Per-application configuration, learned or supplied by the tester — never hardcoded, per
 * CLAUDE.md § "generic vs per-application".
 *
 * The form variant identifies its controls by accessible name rather than by CSS selector, so it
 * uses the same notion of identity the rest of the system does and survives a restyle of the
 * login page.
 */
export const AuthProfile = contract(
  'AuthProfile',
  z
    .discriminatedUnion('kind', [
      z
        .strictObject({ kind: z.literal('none') })
        .describe('The application needs no authentication to crawl.')
        .meta({ title: 'NoAuthProfile' }),

      z
        .strictObject({
          kind: z.literal('form'),
          /** Path of the login page, relative to the application's base URL. */
          loginPath: RoutePath,
          /** Accessible name of the username control, e.g. "Email address". */
          usernameLabel: NonEmptyString,
          /** Accessible name of the password control. */
          passwordLabel: NonEmptyString,
          /** Accessible name of the control that submits the login form. */
          submitLabel: NonEmptyString,
          /**
           * Resolves to a JSON document `{"username": …, "password": …}`.
           *
           * One reference rather than two so a rotation is atomic: a username and a password
           * fetched from separate places can be read a moment apart and disagree.
           */
          credentialsRef: SecretRef,
          /** Path that must be reached for the login to count as successful. */
          successPath: RoutePath,
        })
        .describe(
          'Form login, using credentials fetched from a tenant-configured secret reference.',
        )
        .meta({ title: 'FormAuthProfile' }),

      z
        .strictObject({
          kind: z.literal('storage_state'),
          /**
           * Resolves to a Playwright `storageState` document captured by the tester.
           *
           * Referenced rather than inlined because the blob contains live session cookies and
           * bearer tokens — it is a credential, and CLAUDE.md § "PII rule" applies to it whole.
           */
          stateRef: SecretRef,
        })
        .describe('A browser storage state captured by the tester and held outside WisprTest.')
        .meta({ title: 'StorageStateAuthProfile' }),
    ])
    .describe('How the indexer authenticates against the application under test.'),
);
export type AuthProfile = z.infer<typeof AuthProfile>;

/** The window geometry every fingerprint on a crawl is normalised against. */
export const CrawlViewport = contract(
  'CrawlViewport',
  z
    .strictObject({
      width: z.int().min(320).max(7680),
      height: z.int().min(240).max(4320),
    })
    .describe('Browser viewport the crawl runs at; fingerprint geometry is normalised to it.'),
);
export type CrawlViewport = z.infer<typeof CrawlViewport>;

/**
 * Everything that stops a crawl from running away or doing damage.
 *
 * All required, no defaults. docs/BUILD-PLAN.md Phase 5: "These bounds are config, and the crawl
 * must refuse to start without them" — expressing that here means the refusal happens at schema
 * validation, before a browser exists, rather than in a check somebody can forget to write.
 */
export const CrawlBounds = contract(
  'CrawlBounds',
  z
    .strictObject({
      /**
       * Origins the crawler may navigate to, as absolute `http(s)` URLs.
       *
       * The allowlist half of the SSRF defence in ARCHITECTURE § 8. A link to anywhere else is
       * recorded as skipped, never followed.
       */
      allowedOrigins: z
        .array(HttpUrl)
        .min(1)
        .describe('Origins the crawler may navigate to. Anything else is skipped.'),

      /**
       * Path prefixes the crawler may enter, e.g. `["/orders", "/settings"]`.
       *
       * `["/"]` allows the whole application. Prefixes rather than patterns: a route the crawler
       * has not seen yet cannot be matched against a pattern derived from routes it has.
       */
      routeAllowlist: z
        .array(RoutePath)
        .min(1)
        .describe('Path prefixes the crawl may enter. ["/"] permits the whole application.'),

      /** How far from the base URL the BFS may travel. 0 crawls the entry route alone. */
      maxDepth: z.int().min(0).max(32).describe('Maximum BFS depth from the base URL.'),

      /** Hard cap on distinct screens indexed, whatever the depth allows. */
      maxPages: z.int().min(1).max(5000).describe('Maximum number of screens to index.'),

      /**
       * CSS selectors the crawler must never interact with.
       *
       * The one place a raw selector is the right tool: this list is a customer-authored
       * prohibition, not a resolution strategy, and it has to be evaluable before an element has
       * been fingerprinted. An empty list is legitimate for a read-only application; the key
       * itself is required so that "no destructive controls" is something a human decided.
       */
      neverInteractSelectors: z
        .array(NonEmptyString)
        .describe('Selectors the crawl may never click. Evaluated before any interaction.'),

      /**
       * Interactions attempted per screen while deriving nav edges.
       *
       * Nav edges are observed, not declared, and every observation costs a click plus a return
       * navigation. This is what keeps that quadratic in check. 0 indexes elements without
       * deriving any edges.
       */
      maxInteractionsPerRoute: z
        .int()
        .min(0)
        .max(200)
        .describe('Interactions attempted per screen when observing navigation edges.'),

      /**
       * How long to watch for a navigation after a click, before concluding there was not one.
       *
       * Most controls on a screen open a menu, toggle a filter or focus a field, and only some
       * navigate — so this is paid in full for every candidate that does *not* produce an edge.
       * It is separate from `navigationTimeoutMs` because the two answer different questions:
       * how long a navigation may take, versus how long to wait to find out whether one started.
       */
      interactionObserveMs: z
        .int()
        .min(50)
        .max(30_000)
        .describe('How long to watch for a navigation after a click, in ms.'),

      /** Quiet period after network idle before the DOM is read, in milliseconds. */
      settleDelayMs: z.int().min(0).max(30_000).describe('Settle delay after network idle, in ms.'),

      /** How long to wait for network idle before settling anyway. */
      networkIdleTimeoutMs: z.int().min(100).max(120_000).describe('Network idle timeout, in ms.'),

      /** How long a single navigation may take before it counts as failed. */
      navigationTimeoutMs: z.int().min(100).max(300_000).describe('Per-navigation timeout, in ms.'),

      /**
       * Navigation rate ceiling. ARCHITECTURE § 5: "Crawl is bounded by an allowlist, a depth
       * cap, and a rate limit." A crawl is a load test nobody asked for unless it is throttled.
       */
      requestsPerMinute: z
        .int()
        .min(1)
        .max(600)
        .describe('Maximum navigations per minute against the application under test.'),

      viewport: CrawlViewport,
    })
    .describe(
      'The limits a crawl runs under. Every field required; an unbounded crawl cannot be requested.',
    ),
);
export type CrawlBounds = z.infer<typeof CrawlBounds>;

/**
 * One unit of indexing work: crawl this application, produce a memory version.
 *
 * Enqueued on a Redis stream by the gateway and consumed by an indexer worker. The job carries
 * its own bounds and auth profile rather than having the worker look them up, so the record of
 * what a crawl was permitted to do is the same record that was executed.
 */
export const CrawlJob = contract(
  'CrawlJob',
  z
    .strictObject({
      jobId: Uuid,
      tenantId: Uuid,
      applicationId: Uuid,
      /** Where the crawl starts. Must itself satisfy `bounds.allowedOrigins`. */
      baseUrl: HttpUrl,
      bounds: CrawlBounds,
      authProfile: AuthProfile,
      /** The user who asked for this index. Written to `audit_log` by the gateway. */
      requestedBy: Uuid,
      requestedAt: IsoDateTime,
      /**
       * W3C `traceparent` of the request that enqueued the job, so the crawl's spans join the
       * console's trace instead of starting a disconnected one. Null when untraced.
       */
      traceparent: NonEmptyString.nullable(),
    })
    .describe('A request to crawl one application and build a new memory version.'),
);
export type CrawlJob = z.infer<typeof CrawlJob>;

/** Why a candidate route was not indexed. Every skip is reported; none is silent. */
export const CrawlSkipReason = contract(
  'CrawlSkipReason',
  z
    .enum([
      'off_allowlist',
      'depth_exceeded',
      'page_cap_reached',
      'already_indexed',
      'navigation_failed',
      'ssrf_rejected',
      'non_html_content',
    ])
    .describe('Why a discovered route was not indexed.'),
);
export type CrawlSkipReason = z.infer<typeof CrawlSkipReason>;

/**
 * Why an index job failed. Mirrors the indexer's error taxonomy, which is what a typed taxonomy
 * is for: the console renders a cause, not a stack trace.
 */
export const IndexFailureCode = contract(
  'IndexFailureCode',
  z
    .enum([
      'bounds_invalid',
      'ssrf_rejected',
      'auth_failed',
      'secret_unavailable',
      'browser_failed',
      'navigation_failed',
      'budget_exhausted',
      'persistence_failed',
      'cancelled',
    ])
    .describe('Cause of an index job failure, as written to memory_versions.failure_reason.'),
);
export type IndexFailureCode = z.infer<typeof IndexFailureCode>;

/**
 * Progress streamed from the indexer to the console while a crawl runs.
 *
 * Every member carries `jobId`, `tenantId`, `sequence` and `at`: the console renders these live
 * and a dropped or reordered delivery must be detectable, which a monotonic per-job sequence
 * makes trivial.
 *
 * PII: nothing here carries element text. Accessible names appear nowhere in this union — the
 * console reads them from memory, which stores the redacted form, rather than from the event
 * stream. Route paths do appear, because a crawl the tester cannot follow is not observable, and
 * a path is structure rather than content.
 */
export const IndexProgressEvent = contract(
  'IndexProgressEvent',
  z
    .discriminatedUnion('kind', [
      z
        .strictObject({
          kind: z.literal('job_started'),
          jobId: Uuid,
          tenantId: Uuid,
          sequence: Ordinal,
          at: IsoDateTime,
          /** The `building` version this crawl is filling in. */
          memoryVersionId: Uuid,
          version: z.int().min(1),
          /** True when a crashed job is being continued rather than started fresh. */
          resumed: z.boolean(),
        })
        .meta({ title: 'IndexJobStarted' }),

      z
        .strictObject({
          kind: z.literal('route_started'),
          jobId: Uuid,
          tenantId: Uuid,
          sequence: Ordinal,
          at: IsoDateTime,
          path: RoutePath,
          depth: Ordinal,
        })
        .meta({ title: 'IndexRouteStarted' }),

      z
        .strictObject({
          kind: z.literal('route_indexed'),
          jobId: Uuid,
          tenantId: Uuid,
          sequence: Ordinal,
          at: IsoDateTime,
          screenId: Uuid,
          routePattern: RoutePattern,
          stateFingerprint: StateFingerprint,
          elementCount: z.int().min(0),
          durationMs: LatencyMs,
        })
        .meta({ title: 'IndexRouteIndexed' }),

      z
        .strictObject({
          kind: z.literal('route_skipped'),
          jobId: Uuid,
          tenantId: Uuid,
          sequence: Ordinal,
          at: IsoDateTime,
          path: RoutePath,
          reason: CrawlSkipReason,
        })
        .meta({ title: 'IndexRouteSkipped' }),

      z
        .strictObject({
          kind: z.literal('edge_recorded'),
          jobId: Uuid,
          tenantId: Uuid,
          sequence: Ordinal,
          at: IsoDateTime,
          fromScreenId: Uuid,
          toScreenId: Uuid,
          triggerElementKey: ElementKey,
          confidence: Confidence,
        })
        .meta({ title: 'IndexEdgeRecorded' }),

      z
        .strictObject({
          kind: z.literal('job_completed'),
          jobId: Uuid,
          tenantId: Uuid,
          sequence: Ordinal,
          at: IsoDateTime,
          memoryVersionId: Uuid,
          screenCount: z.int().min(0),
          elementCount: z.int().min(0),
          edgeCount: z.int().min(0),
          durationMs: LatencyMs,
        })
        .meta({ title: 'IndexJobCompleted' }),

      z
        .strictObject({
          kind: z.literal('job_failed'),
          jobId: Uuid,
          tenantId: Uuid,
          sequence: Ordinal,
          at: IsoDateTime,
          /** Null when the failure happened before a version row existed. */
          memoryVersionId: Uuid.nullable(),
          code: IndexFailureCode,
          /** Operator-facing detail. Structural only — never a page's text. */
          detail: NonEmptyString,
        })
        .meta({ title: 'IndexJobFailed' }),
    ])
    .describe('Live progress of an index job, streamed to the console.'),
);
export type IndexProgressEvent = z.infer<typeof IndexProgressEvent>;
