import { z } from 'zod';

import { VoicePhase } from './voice/messages.js';

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
  /**
   * The content script found its held snapshot stale — a `memory_version_mismatch` — and is
   * asking the worker to refetch. Out of band: it never blocks a resolution, per the contract's
   * note on that error code.
   */
  z.strictObject({ kind: z.literal('refetch_snapshot') }),
  /**
   * The tester engaged push-to-talk (or toggled it on). The hotkey is detected in the content
   * script — the offscreen document sees no keyboard events — and relayed here so the worker can
   * bring the microphone up. It carries no audio and no key: just the intent to start.
   */
  z.strictObject({ kind: z.literal('voice_start') }),
  /** Push-to-talk released, toggled off, or focus lost. The worker finalizes and releases the mic. */
  z.strictObject({ kind: z.literal('voice_stop') }),
  /**
   * T0 and T1 both missed: escalate this phrase to the gateway's model (Phase 11).
   *
   * The request travels opaquely and is validated against `EscalateRequest` in the worker, for the
   * same reason the snapshot is validated on arrival — this internal channel ships in one artifact
   * with both ends and has no business restating the cross-deployable contract. `requestId`
   * correlates the reply: a port is a stream, not a call, and two escalations can be in flight
   * when speech revises mid-utterance.
   */
  z.strictObject({
    kind: z.literal('escalate'),
    requestId: z.string().min(1),
    request: z.unknown(),
  }),
  /**
   * A learned phrase → element mapping, on its way to the write-back queue.
   *
   * Fire-and-forget by design: the resolution it came from has already been returned, and nothing
   * on the hot path waits for vocabulary to be persisted. The queue in the worker batches these
   * and flushes every 10s and on detach.
   */
  z.strictObject({ kind: z.literal('alias_writeback'), writeback: z.unknown() }),
  /**
   * One recorded step, on its way to the session buffer.
   *
   * Fire-and-forget like a write-back: the action it describes has already run, and nothing waits
   * on it being persisted. The buffer in the worker batches these and flushes every 5s and on
   * detach — and holds them in `chrome.storage.session`, so a worker restart mid-session does not
   * lose the tester's history.
   */
  z.strictObject({ kind: z.literal('session_step'), step: z.unknown() }),
  /**
   * Capture evidence for a step that is about to be recorded.
   *
   * The content script sends what only it can produce — the redacted DOM snapshot, and the region
   * of the page to photograph — and the worker does what only it can: take the screenshot over the
   * debugger it already holds, and upload both with the scoped token. The reply carries the
   * references to record.
   *
   * Correlated by `requestId`, and awaited: a step's evidence has to be on the step when it is
   * buffered, because a timeline is append-only and there is no second chance to attach it.
   */
  z.strictObject({
    kind: z.literal('capture_evidence'),
    requestId: z.string().min(1),
    stepOrdinal: z.number().int().nonnegative(),
    /** Already redacted by the content script. The worker never sees raw page text. */
    snapshotHtml: z.string(),
    region: z.strictObject({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
  }),
  /**
   * Compose a plan for a seeding utterance. Writes nothing — `/v1/seed/plan` is a read.
   *
   * The content script sends only what it alone knows: what the tester said, and where they are.
   * The session and application ids are the worker's, deliberately (`background/seed-client.ts`),
   * so a page the extension does not control never holds the identifier that scopes a write to a
   * customer's application.
   */
  z.strictObject({
    kind: z.literal('seed_plan'),
    requestId: z.string().min(1),
    utterance: z.string().min(1),
    /** A `RuntimeState`, validated against the contract in the worker. */
    runtimeState: z.unknown(),
  }),
  /**
   * The tester approved a previewed plan. The one message on this channel that writes.
   *
   * It carries a `planId` and no plan, for exactly the reason `SeedExecuteRequest` does: the
   * gateway is already holding the composed plan, so what was previewed is what gets written and a
   * message cannot describe a record into existence.
   */
  z.strictObject({
    kind: z.literal('seed_execute'),
    requestId: z.string().min(1),
    planId: z.string().min(1),
    /** The tester's own approval instant. Evidence in the audit log, never authority. */
    approvedAt: z.string().min(1),
  }),
  /** Undo one seeded record, or everything this session seeded. */
  z.strictObject({
    kind: z.literal('seed_revert'),
    requestId: z.string().min(1),
    scope: z.enum(['entry', 'session']),
    /** Set exactly when `scope` is `entry`. The session's id is the worker's own. */
    ledgerEntryId: z.string().min(1).nullable(),
  }),
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

/**
 * Where the memory snapshot is, as the HUD is allowed to know it.
 *
 * `loaded` means the content script has a snapshot and the resolver is live; `stale` means a
 * version mismatch was seen and a refetch is in flight, and the tester keeps working against the
 * held snapshot meanwhile — a refetch never blocks the hot path.
 */
export const SnapshotState = z.enum(['absent', 'loading', 'loaded', 'stale', 'failed']);
export type SnapshotState = z.infer<typeof SnapshotState>;

/**
 * Service worker → content script: the memory snapshot itself.
 *
 * The snapshot is Product Memory — redacted structure, never page content — so it is safe to hand
 * to the content script, which is where the resolver runs (the hot path is in-process). It is
 * carried opaquely here and validated against `MemorySnapshot` on arrival: this internal channel
 * ships in one artifact with both ends and has no reason to restate the cross-deployable contract.
 */
export const HudSnapshot = z.strictObject({
  kind: z.literal('snapshot'),
  state: SnapshotState,
  applicationId: z.string().nullable(),
  /** The held version, so the content script can tell a refetch's result apart from a no-op. */
  memoryVersionId: z.string().nullable(),
  /** The `MemorySnapshot`, present only when `state` is `loaded`. Validated by the receiver. */
  snapshot: z.unknown(),
});
export type HudSnapshot = z.infer<typeof HudSnapshot>;

/** One line of transcript with the revision it was produced at, so the HUD can order updates. */
export const HudVoiceLine = z.strictObject({
  revision: z.number().int().nonnegative(),
  text: z.string(),
});
export type HudVoiceLine = z.infer<typeof HudVoiceLine>;

/**
 * Service worker → content script: the voice pipeline's tester-facing state.
 *
 * The worker distils the offscreen document's event stream into a single current picture, the same
 * way it does for attach state — the HUD renders from this directly and a message missed while the
 * tab was backgrounded cannot strand it in a state that never existed.
 *
 * `final` is the last committed line, rendered as confirmed; `partial` is the in-flight hypothesis,
 * rendered as the *unconfirmed tail*, visually distinguished, per the phase requirement. The text
 * here is the tester's own speech held for the session only — never the application's content.
 */
export const HudVoice = z.strictObject({
  kind: z.literal('voice'),
  phase: VoicePhase,
  /** VAD activity in [0, 1], for the meter. 0 when not listening. */
  level: z.number().min(0).max(1),
  partial: HudVoiceLine.nullable(),
  final: HudVoiceLine.nullable(),
});
export type HudVoice = z.infer<typeof HudVoice>;

/**
 * Service worker → content script: the answer to one escalation.
 *
 * Shaped as the resolver's own `EscalationOutcome` so the content script's transport can hand it
 * straight back with no translation layer to drift. `response` is carried opaquely and validated
 * against `EscalateResponse` by the worker before it is sent, so a failed validation arrives as a
 * clean `not_found` rather than as a malformed pick the content script has to defend against.
 */
export const HudEscalateResult = z.strictObject({
  kind: z.literal('escalate_result'),
  requestId: z.string().min(1),
  ok: z.boolean(),
  /** Present when `ok`; an `EscalateResponse`, validated by the receiver. */
  response: z.unknown(),
  /** Present when not `ok`: why the escalation produced no pick. */
  reason: z.enum(['timeout', 'unavailable', 'not_found']).nullable(),
});
export type HudEscalateResult = z.infer<typeof HudEscalateResult>;

/**
 * Service worker → content script: what was captured, and where it was stored.
 *
 * `refs` is an array because a capture produces up to two artifacts and either may fail on its
 * own — a screenshot the debugger could not take does not cost the DOM snapshot beside it. An
 * empty array is a normal answer, and the step is recorded without evidence.
 */
export const HudEvidenceResult = z.strictObject({
  kind: z.literal('evidence_result'),
  requestId: z.string().min(1),
  /** `EvidenceRef`s, validated by the receiver against the contract. */
  refs: z.array(z.unknown()),
});
export type HudEvidenceResult = z.infer<typeof HudEvidenceResult>;

/**
 * Service worker → content script: the answer to one seed call.
 *
 * One shape for all three routes, correlated by `requestId`, because the HUD's controller settles
 * them the same way and a message per route would be three copies of the same envelope. `payload`
 * is the route's response carried opaquely and validated against its contract by the worker before
 * it is sent — a preview card is rendered from this, and a tester approves what the card says.
 *
 * `reason` is the closed set from `background/seed-client.ts`. `forbidden` is its own member
 * because it is the one failure a tester cannot retry their way out of: seeding is not enabled for
 * this application, which is policy rather than an outage, and the card has to say so.
 */
export const HudSeedResult = z.strictObject({
  kind: z.literal('seed_result'),
  requestId: z.string().min(1),
  call: z.enum(['plan', 'execute', 'revert']),
  ok: z.boolean(),
  /** Present when `ok`: the route's response, validated by the worker. */
  payload: z.unknown(),
  /** Present when not `ok`: why the call produced no answer. */
  reason: z.enum(['unavailable', 'timeout', 'forbidden', 'invalid', 'failed']).nullable(),
  /** Concrete detail from the gateway, when it sent one. Never a token or a request body. */
  detail: z.string().nullable(),
});
export type HudSeedResult = z.infer<typeof HudSeedResult>;

/** Everything the worker may push to the content script. */
export type WorkerMessage =
  HudUpdate | HudSnapshot | HudVoice | HudEscalateResult | HudEvidenceResult | HudSeedResult;

/** Parse any worker → content message, or null if it is not one of ours. */
export function parseWorkerMessage(message: unknown): WorkerMessage | null {
  if (typeof message !== 'object' || message === null) return null;
  const kind = (message as { kind?: unknown }).kind;
  if (kind === 'snapshot') {
    const parsed = HudSnapshot.safeParse(message);
    return parsed.success ? parsed.data : null;
  }
  if (kind === 'voice') {
    const parsed = HudVoice.safeParse(message);
    return parsed.success ? parsed.data : null;
  }
  if (kind === 'escalate_result') {
    const parsed = HudEscalateResult.safeParse(message);
    return parsed.success ? parsed.data : null;
  }
  if (kind === 'evidence_result') {
    const parsed = HudEvidenceResult.safeParse(message);
    return parsed.success ? parsed.data : null;
  }
  if (kind === 'seed_result') {
    const parsed = HudSeedResult.safeParse(message);
    return parsed.success ? parsed.data : null;
  }
  return parseUpdate(message);
}

/** The voice state a freshly connected HUD shows before anyone has spoken. */
export const INITIAL_VOICE: HudVoice = {
  kind: 'voice',
  phase: 'idle',
  level: 0,
  partial: null,
  final: null,
};

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
