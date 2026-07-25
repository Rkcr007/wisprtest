import { z } from 'zod';

/**
 * The channel between the content script and the service worker.
 *
 * These two halves ship in one artifact and are versioned together, which is why this contract
 * lives here rather than in `packages/protocol` — that package is for payloads crossing between
 * *deployables*, where two sides can be at different versions. Both ends still parse every
 * message: a content script runs in a page the extension does not control, and an unvalidated
 * message from one is a message from whatever else is running there.
 *
 * ## A long-lived port, not one-off messages
 *
 * The content script opens the port; the worker replies and pushes over it. That direction
 * matters: pushing *to* a content script with `chrome.tabs.sendMessage` needs host permission for
 * the tab, while a port the content script opened needs nothing. It also gives the worker a
 * disconnect signal it can use to drop per-tab state when the tab navigates away or closes.
 *
 * ## What never crosses
 *
 * The scoped token. The content script is given the token's *state* — valid, expiring, failed —
 * and never its value, so an XSS in the application under test cannot read a credential out of
 * the page it has compromised. Requests that need the token are made by the worker.
 *
 * Page content, likewise, never travels the other way. `origin` is structure; a URL path, a
 * heading or an element's text is content, and CLAUDE.md § "PII rule" keeps it in the page.
 */

/** Name of the port. Chrome surfaces it on the worker side, so it identifies our connections. */
export const HUD_PORT = 'wispr:hud';

/** Where the attach state machine is. Surfaced in the HUD's state band. */
export const AttachState = z.enum(['detached', 'attaching', 'attached', 'failed']);
export type AttachState = z.infer<typeof AttachState>;

/**
 * Why an attach failed, as a closed set the HUD can phrase for a tester.
 *
 * A closed set rather than a message string because the HUD has to say something a tester can
 * act on: "unauthenticated" means sign in to the console, "unreachable" means the gateway is down
 * and it is not their fault, "internal" means neither and is worth reporting.
 *
 * There is deliberately no member for "this origin is not a registered application". That is not
 * a failure — a token is minted, the extension is attached, and the answer is simply that nobody
 * has indexed this application yet. It is carried by `applicationId: null` on the update below,
 * and the HUD says so plainly rather than showing a tester an error for browsing a normal page.
 */
export const AttachFailure = z.enum(['unauthenticated', 'unreachable', 'internal']);
export type AttachFailure = z.infer<typeof AttachFailure>;

/** The token's state, as the HUD is allowed to know it. Never the token itself. */
export const TokenState = z.enum(['absent', 'valid', 'refreshing', 'failed']);
export type TokenState = z.infer<typeof TokenState>;

/** Content script → service worker. */
export const HudRequest = z.discriminatedUnion('kind', [
  /** Sent on connect. The origin is all the worker needs to mint a scoped token. */
  z.strictObject({ kind: z.literal('hello'), origin: z.string().min(1) }),
  /** The tester asked to attach — from the HUD's own control or the toolbar button. */
  z.strictObject({ kind: z.literal('attach') }),
  /** The tester detached, or the HUD is unmounting. */
  z.strictObject({ kind: z.literal('detach') }),
]);
export type HudRequest = z.infer<typeof HudRequest>;

/**
 * Service worker → content script.
 *
 * One message shape carrying the whole session state rather than a stream of deltas: the HUD
 * renders from it directly, and a content script that misses a message while its tab was
 * backgrounded cannot end up displaying a state that never existed.
 */
export const HudUpdate = z.strictObject({
  kind: z.literal('state'),
  attach: AttachState,
  /** Set only when `attach` is `failed`. */
  failure: AttachFailure.nullable(),
  token: TokenState,
  /** Null until a token has been minted. */
  tenantId: z.string().nullable(),
  /** Null when this origin matches no registered application — a normal answer, not an error. */
  applicationId: z.string().nullable(),
  /** When the current token expires, so the HUD can show that it is short-lived. */
  tokenExpiresAt: z.string().nullable(),
});
export type HudUpdate = z.infer<typeof HudUpdate>;

/** Parse a message from the worker, or null if it is not one of ours. */
export function parseUpdate(message: unknown): HudUpdate | null {
  const parsed = HudUpdate.safeParse(message);
  return parsed.success ? parsed.data : null;
}

/** Parse a message from a content script, or null if it is not one of ours. */
export function parseRequest(message: unknown): HudRequest | null {
  const parsed = HudRequest.safeParse(message);
  return parsed.success ? parsed.data : null;
}

/** The state a freshly connected HUD shows before the worker has said anything. */
export const INITIAL_UPDATE: HudUpdate = {
  kind: 'state',
  attach: 'detached',
  failure: null,
  token: 'absent',
  tenantId: null,
  applicationId: null,
  tokenExpiresAt: null,
};
