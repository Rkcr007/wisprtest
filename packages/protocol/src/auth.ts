import { z } from 'zod';

import { HttpUrl, IsoDateTime, NonEmptyString, Uuid } from './primitives.js';
import { contract } from './registry.js';

/**
 * The extension's scoped token — the one credential that crosses from the control plane into the
 * tester's browser.
 *
 * docs/ARCHITECTURE.md § 8: "the extension holds a short-lived scoped token refreshed by the
 * service worker". This module is the shape of that exchange. Two properties are load-bearing:
 *
 * - **Short-lived.** `expiresAt` is required and absolute. A token with no stated expiry is one
 *   the service worker cannot refresh ahead of time, so it would be discovered stale by a request
 *   failing mid-session — which, on the hot path, is a command that does not run.
 * - **Scoped.** The token names what it may do. The extension needs to read memory and write
 *   sessions; it has no business approving a drift report or registering an application, and a
 *   token that could is one XSS away from doing so in a customer's tab.
 *
 * The exchange itself is authenticated by the tester's existing console session — the extension
 * never handles the tester's OIDC credentials, and WisprTest never handles the application under
 * test's (see `AuthProfile` in the indexing module for that separate case).
 */

/**
 * What a scoped token may do, named after the gateway routes in docs/ARCHITECTURE.md § 5.
 *
 * A closed set, deliberately small. Every entry corresponds to a route the extension actually
 * calls; there is no wildcard and no `admin`, because the extension has no reason to hold either.
 */
export const ExtensionTokenScope = contract(
  'ExtensionTokenScope',
  z
    .enum([
      /** `GET /v1/memory/:appId/snapshot` — the snapshot fetched on attach. */
      'memory:read',
      /** `POST /v1/memory/aliases` — the T2 write-back that makes the compounding loop work. */
      'alias:write',
      /** `POST /v1/sessions/:id/steps` — batched step ingest. */
      'session:write',
      /** `POST /v1/resolve/escalate` — T2 escalation. */
      'resolve:escalate',
      /** `POST /v1/seed/plan` — composition preview. Writes nothing. */
      'seed:plan',
      /** `POST /v1/seed/execute` and `/revert` — the only scope that mutates a customer's data. */
      'seed:execute',
      /** `POST /v1/drift` — reporting a structural mismatch. Reporting only; never approving. */
      'drift:report',
    ])
    .describe('A capability a scoped extension token may carry.'),
);
export type ExtensionTokenScope = z.infer<typeof ExtensionTokenScope>;

/**
 * The extension asking for a token for the page it is attaching to.
 *
 * It sends an origin rather than an application id because an origin is what a content script
 * knows. Resolving that to an application — within the tenant the session already establishes —
 * is the gateway's job, and doing it there is what stops the extension from being able to name an
 * application it was never granted.
 */
export const ExtensionTokenRequest = contract(
  'ExtensionTokenRequest',
  z
    .strictObject({
      /** Origin of the page the extension is attaching to, e.g. `https://orders.example`. */
      origin: HttpUrl.describe('Origin of the page under test, as the content script sees it.'),
    })
    .describe('Request for a scoped token covering one application origin.'),
);
export type ExtensionTokenRequest = z.infer<typeof ExtensionTokenRequest>;

/**
 * A minted scoped token.
 *
 * `applicationId` is null when the origin matches no registered application in the tenant. That is
 * a normal answer, not an error: a tester browsing an application nobody has indexed should see a
 * HUD that says so, not a failed request with no explanation.
 */
export const ExtensionToken = contract(
  'ExtensionToken',
  z
    .strictObject({
      /**
       * The bearer token. Held in memory and in session storage for the tab's lifetime, never in
       * `localStorage`, never logged, and never included in a telemetry field.
       */
      token: NonEmptyString.describe('Bearer token. Never logged and never persisted to disk.'),
      tokenType: z.literal('Bearer'),
      /** Absolute expiry, so the service worker can refresh before a request fails. */
      expiresAt: IsoDateTime,
      tenantId: Uuid,
      /** Null when the origin matches no registered application in this tenant. */
      applicationId: Uuid.nullable(),
      /** Exactly what this token may do. Never empty — a token with no scopes is not a token. */
      scopes: z.array(ExtensionTokenScope).min(1),
    })
    .describe('A short-lived scoped token issued to the extension for one origin.'),
);
export type ExtensionToken = z.infer<typeof ExtensionToken>;
