import { z } from 'zod';

import {
  Confidence,
  ElementKey,
  HttpUrl,
  IsoDateTime,
  LatencyMs,
  NonEmptyString,
  Ordinal,
  RedactedText,
  RoutePath,
  RoutePattern,
  Sha256Hex,
  StateFingerprint,
  StructuralHash,
  Uuid,
} from './primitives.js';
import { contract } from './registry.js';
import { ResolutionResult, ScopedQuery } from './resolution.js';
import { ActionClass, Tier } from './vocabulary.js';

/**
 * Runtime — the state of the page, the actions dispatched against it, and the record of both.
 */

/**
 * The state vector derived from observable streams, per docs/ARCHITECTURE.md § 3.
 *
 * The in-process type holds `visibleSet` as a `Set<Element>`; the wire form carries element
 * keys, because DOM nodes do not cross a boundary. `stateFingerprint` is the cache key for
 * scoped resolution and the key drift is measured against.
 */
export const RuntimeState = contract(
  'RuntimeState',
  z
    .strictObject({
      /** The concrete path, from History API interception. */
      route: RoutePath,
      /** The same path with identifiers generalised, e.g. `/orders/:id`. */
      routePattern: RoutePattern,
      /** Open dialogs, outermost first. Tracked from `role="dialog"` / `aria-modal`. */
      modalStack: z.array(NonEmptyString).describe('Open dialog labels, outermost first.'),
      /** The active element's nearest landmark, or null when focus is on the body. */
      focusedLandmark: NonEmptyString.nullable(),
      /** Elements currently intersecting the viewport, from IntersectionObserver. */
      visibleElementKeys: z
        .array(ElementKey)
        .describe('Elements currently intersecting the viewport.'),
      structuralHash: StructuralHash,
      stateFingerprint: StateFingerprint,
      capturedAt: IsoDateTime,
    })
    .describe('Derived state of the page under test at one instant.'),
);
export type RuntimeState = z.infer<typeof RuntimeState>;

/**
 * What to do, and with what.
 *
 * Discriminated on `verb` so the executor cannot be handed a `type` action with no text or a
 * `scroll` with a select option. The request itself does not repeat the verb: there is exactly
 * one place it is written, so it cannot disagree with the payload.
 */
export const ActionPayload = contract(
  'ActionPayload',
  z
    .discriminatedUnion('verb', [
      z
        .strictObject({ verb: z.literal('navigate'), route: RoutePath })
        .meta({ title: 'ActionPayloadNavigate', description: 'Follow an indexed nav edge.' }),
      z
        .strictObject({ verb: z.literal('click') })
        .meta({ title: 'ActionPayloadClick', description: 'Activate the target element.' }),
      z
        .strictObject({
          verb: z.literal('type'),
          /** Redacted before it reaches the wire; the keystrokes themselves are not logged. */
          text: RedactedText,
          /** Whether to clear the field first, rather than appending. */
          clearFirst: z.boolean(),
        })
        .meta({ title: 'ActionPayloadType', description: 'Type text into the target field.' }),
      z
        .strictObject({ verb: z.literal('focus') })
        .meta({ title: 'ActionPayloadFocus', description: 'Move focus to the target element.' }),
      z
        .strictObject({
          verb: z.literal('scroll'),
          direction: z.enum(['up', 'down', 'top', 'bottom']),
          /** Pixels to scroll. Null for `top` and `bottom`, which are absolute. */
          amountPx: z.number().min(0).nullable(),
        })
        .meta({ title: 'ActionPayloadScroll', description: 'Scroll the target scroll container.' }),
      z.strictObject({ verb: z.literal('filter'), text: RedactedText }).meta({
        title: 'ActionPayloadFilter',
        description: 'Apply a filter control with the given value.',
      }),
      z
        .strictObject({
          verb: z.literal('check'),
          /** What the tester asserted, in their own redacted words. */
          assertion: RedactedText,
        })
        .meta({
          title: 'ActionPayloadCheck',
          description: 'Record an assertion against the target and capture evidence.',
        }),
      z.strictObject({ verb: z.literal('select'), option: RedactedText }).meta({
        title: 'ActionPayloadSelect',
        description: 'Choose an option in a select control.',
      }),
      z
        .strictObject({ verb: z.literal('back') })
        .meta({ title: 'ActionPayloadBack', description: 'Navigate back in history.' }),
    ])
    .describe('The operation to dispatch, carrying exactly the arguments its verb needs.'),
);
export type ActionPayload = z.infer<typeof ActionPayload>;

/**
 * A request to act on the application under test.
 *
 * The two refinements below are the reversibility taxonomy made structural. They are the
 * reason this schema exists as more than a bag of fields:
 *
 * 1. Only class `R` may be speculative. Speculating on a class `C` action is, in CLAUDE.md's
 *    words, the single worst bug this product can have.
 * 2. A class `C` action may not be dispatched unconfirmed — it needs a finalized transcript
 *    and an explicit yes. Class `S` is the same: a seed is never written without a preview.
 *
 * A caveat worth stating plainly: JSON Schema cannot express a cross-field refinement in a
 * form the pydantic generator will honour, so these two rules are enforced on the TypeScript
 * side only. That is where they matter — the extension is the only component that dispatches
 * actions, and `apps/composer` never constructs an ActionRequest. Any future Python producer
 * of this type must re-assert both rules explicitly.
 */
export const ActionRequest = contract(
  'ActionRequest',
  z
    .strictObject({
      id: Uuid,
      sessionId: Uuid,
      /** The element to act on, resolved and confirmed present in the scoped candidate set. */
      elementId: Uuid,
      elementKey: ElementKey,
      payload: ActionPayload,
      actionClass: ActionClass,
      /** The tier that resolved the target, carried through for telemetry. */
      tier: Tier,
      confidence: Confidence,
      /** True when dispatched from a partial ASR hypothesis rather than a final transcript. */
      speculative: z.boolean(),
      /** True when the tester has explicitly approved this action. */
      confirmed: z.boolean(),
      /** The state the target was resolved in. A mismatch at dispatch time means staleness. */
      stateFingerprint: StateFingerprint,
      issuedAt: IsoDateTime,
    })
    .refine((request) => !request.speculative || request.actionClass === 'R', {
      error: 'only a class R action may be executed speculatively',
      path: ['speculative'],
    })
    .refine((request) => request.actionClass !== 'C' || request.confirmed, {
      error: 'a class C action requires explicit confirmation before dispatch',
      path: ['confirmed'],
    })
    .refine((request) => request.actionClass !== 'S' || request.confirmed, {
      error: 'a class S action requires an approved preview before dispatch',
      path: ['confirmed'],
    })
    .describe('A request to act on the app under test, bound by the reversibility taxonomy.'),
);
export type ActionRequest = z.infer<typeof ActionRequest>;

/**
 * What became of an action.
 *
 * `staged` is a first-class outcome, not a failure: it is what the speculation controller
 * records when it renders a reticle and deliberately does not execute.
 */
export const ActionOutcome = contract(
  'ActionOutcome',
  z
    .enum(['executed', 'staged', 'rolled_back', 'rejected', 'failed'])
    .describe('Terminal state of a dispatched action.'),
);
export type ActionOutcome = z.infer<typeof ActionOutcome>;

/**
 * A pointer to captured evidence. The bytes live in object storage; only the reference and a
 * content hash cross this boundary, so evidence can be verified but never inlined into a log.
 */
export const EvidenceRef = contract(
  'EvidenceRef',
  z
    .strictObject({
      kind: z.enum(['screenshot', 'dom_snapshot']),
      /** Object storage key, resolved to a tenant-scoped signed URL on retrieval. */
      storageKey: NonEmptyString,
      contentHash: Sha256Hex,
      capturedAt: IsoDateTime,
    })
    .describe('Reference to a redacted evidence artifact held in object storage.'),
);
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/** The outcome of one dispatched action, with the latency that gates the release budget. */
export const ActionResult = contract(
  'ActionResult',
  z
    .strictObject({
      actionRequestId: Uuid,
      outcome: ActionOutcome,
      /** Dispatch latency measured from commit, budgeted at p95 < 30 ms. */
      latencyMs: LatencyMs,
      /** Populated when `outcome` is `failed` or `rejected`; a plain-language reason. */
      reason: NonEmptyString.nullable(),
      evidence: z.array(EvidenceRef),
      completedAt: IsoDateTime,
    })
    .describe('Result of dispatching one action, including why it did not execute.'),
);
export type ActionResult = z.infer<typeof ActionResult>;

/**
 * One row of the session timeline.
 *
 * Every action emits one, whether it executed or was merely staged. Together they are the
 * replayable record of a test, the evidence trail behind a bug report, and the source of the
 * tier distribution metric that tells us whether the compounding loop is working.
 */
export const SessionStep = contract(
  'SessionStep',
  z
    .strictObject({
      id: Uuid,
      sessionId: Uuid,
      /** Monotonic within the session. Step ingest is idempotent on `(sessionId, ordinal)`. */
      ordinal: Ordinal,
      /** The redacted utterance. Raw audio is never persisted and neither is raw transcript. */
      utterance: RedactedText,
      intent: ScopedQuery,
      resolution: ResolutionResult,
      /** Null when the step never produced an action — a failed resolution, for instance. */
      elementId: Uuid.nullable(),
      tier: Tier.nullable(),
      confidence: Confidence.nullable(),
      actionClass: ActionClass.nullable(),
      /** End to end: speech onset to action completion. */
      latencyMs: LatencyMs,
      outcome: ActionOutcome,
      evidence: z.array(EvidenceRef),
      createdAt: IsoDateTime,
    })
    .describe('One recorded step of a testing session, with its evidence and telemetry.'),
);
export type SessionStep = z.infer<typeof SessionStep>;

/**
 * A testing session: one tester, one application, one memory version, one sitting.
 *
 * `endedAt` is the whole state machine. A session is open while it is null and closed the moment
 * it is not, and closed is terminal — no further steps, no reopening, enforced in the API rather
 * than only in the console (docs/BUILD-PLAN.md Phase 12). There is deliberately no separate
 * `status` field: two representations of one fact are two things that can disagree, and this one
 * is evidence.
 *
 * The tenant and the user are not in the open request — they come from the scoped token, so a
 * session cannot be opened against a tenant the caller was not granted.
 */
export const Session = contract(
  'Session',
  z
    .strictObject({
      id: Uuid,
      tenantId: Uuid,
      applicationId: Uuid,
      /** The memory the session resolved against; a timeline is only replayable against it. */
      memoryVersionId: Uuid,
      userId: Uuid,
      startedAt: IsoDateTime,
      /** Null while the session is open. Set once, by the server's clock, and never again. */
      endedAt: IsoDateTime.nullable(),
    })
    .describe('One testing session. Open while endedAt is null; closed is terminal.'),
);
export type Session = z.infer<typeof Session>;

/**
 * Opening a session.
 *
 * The memory version is named by the caller rather than resolved server-side: the extension has
 * already loaded a snapshot and resolved against *that* version, and a session recorded against a
 * different one would be a timeline nobody can replay.
 */
export const SessionOpenRequest = contract(
  'SessionOpenRequest',
  z
    .strictObject({
      applicationId: Uuid,
      memoryVersionId: Uuid,
    })
    .describe('Open a session for one application at one memory version.'),
);
export type SessionOpenRequest = z.infer<typeof SessionOpenRequest>;

/**
 * Closing a session.
 *
 * The transition is named explicitly rather than implied by an empty PATCH body, so that a
 * malformed or truncated request cannot close a session by accident — and so a later PATCH that
 * changes something else is an additive field rather than a change of meaning.
 *
 * There is no `endedAt`: the server stamps it. A client clock that is wrong, or a flush that
 * arrives late, must not be able to backdate evidence.
 */
export const SessionCloseRequest = contract(
  'SessionCloseRequest',
  z
    .strictObject({
      status: z.literal('closed'),
    })
    .describe('Close a session. Terminal: no further steps are accepted afterwards.'),
);
export type SessionCloseRequest = z.infer<typeof SessionCloseRequest>;

/**
 * A batch of steps for one session.
 *
 * Batched because the extension buffers and flushes every 5s and on detach rather than making a
 * request per action — the control plane is not on the hot path. Ingest is idempotent on
 * `(sessionId, ordinal)`, which is what makes a retry after a failed flush safe: the same batch
 * sent twice is one timeline, not two.
 *
 * Every step also carries its own `sessionId`. The gateway rejects a batch whose steps disagree
 * with the session in the path, so a buffer that survived a worker restart cannot spill one
 * session's steps into another's timeline.
 */
export const SessionStepBatch = contract(
  'SessionStepBatch',
  z
    .strictObject({
      steps: z
        .array(SessionStep)
        .min(1)
        .describe('At least one step; an empty batch is a bug, not a no-op.'),
    })
    .describe('Steps to append to one session, idempotent on (sessionId, ordinal).'),
);
export type SessionStepBatch = z.infer<typeof SessionStepBatch>;

/**
 * What the gateway reports after ingesting a batch.
 *
 * `inserted` and `duplicates` sum to `accepted`. The split is what makes a retry legible: a flush
 * that is entirely duplicates means the previous attempt landed and the extension's buffer was
 * simply not told, which is a normal outcome rather than an error.
 */
export const SessionStepIngestResult = contract(
  'SessionStepIngestResult',
  z
    .strictObject({
      accepted: z.int().min(0).describe('Total steps processed.'),
      inserted: z.int().min(0).describe('Steps that were new to the timeline.'),
      duplicates: z
        .int()
        .min(0)
        .describe('Steps already present at that ordinal, and therefore ignored.'),
    })
    .describe('Outcome of ingesting a batch of session steps.'),
);
export type SessionStepIngestResult = z.infer<typeof SessionStepIngestResult>;

/**
 * A short-lived, tenant-scoped URL for one evidence artifact.
 *
 * Evidence bytes live in object storage and are never inlined into a response — a DOM snapshot is
 * kilobytes and a timeline may reference hundreds. What crosses is a URL that expires, so the
 * console can render a screenshot without ever holding an object-storage credential, and a link
 * that leaks out of a bug report stops working.
 */
export const SignedEvidence = contract(
  'SignedEvidence',
  z
    .strictObject({
      storageKey: NonEmptyString,
      url: HttpUrl.describe('Pre-signed retrieval URL, valid until expiresAt.'),
      expiresAt: IsoDateTime,
    })
    .describe('A pre-signed, expiring URL for one stored evidence artifact.'),
);
export type SignedEvidence = z.infer<typeof SignedEvidence>;

/**
 * Asking the gateway where to put one piece of evidence.
 *
 * The extension has already captured and redacted the bytes; what it needs is somewhere to put
 * them. It sends the *hash* rather than the bytes, and gets back a key and a short-lived upload
 * URL — so a screenshot never transits the gateway's request pipeline, and the control plane
 * spends no bandwidth proxying a customer's pixels.
 *
 * `contentHash` is the extension's own SHA-256 of what it is about to upload. It becomes part of
 * the storage key, which is what makes a retried capture land on the same object instead of
 * accumulating copies, and it is what a later audit verifies the retrieved bytes against.
 */
export const EvidenceUploadRequest = contract(
  'EvidenceUploadRequest',
  z
    .strictObject({
      kind: z.enum(['screenshot', 'dom_snapshot']),
      /** The step this evidence belongs to; part of the key, so a timeline is browsable by hand. */
      stepOrdinal: Ordinal,
      contentHash: Sha256Hex,
      /** How the object will be served back. Fixed per kind, but stated rather than inferred. */
      contentType: NonEmptyString,
    })
    .describe('A request for somewhere to upload one captured, already-redacted artifact.'),
);
export type EvidenceUploadRequest = z.infer<typeof EvidenceUploadRequest>;

/**
 * Where to put it, and for how long the offer stands.
 *
 * The URL is a pre-signed PUT: it authorises exactly one object, expires, and carries no
 * credential the extension could reuse for anything else. `storageKey` is what the extension then
 * records on the step — the database holds the reference, never the bytes.
 */
export const EvidenceUploadTicket = contract(
  'EvidenceUploadTicket',
  z
    .strictObject({
      storageKey: NonEmptyString,
      uploadUrl: HttpUrl.describe('Pre-signed PUT URL for exactly this object.'),
      expiresAt: IsoDateTime,
    })
    .describe('A short-lived, single-object upload authorisation.'),
);
export type EvidenceUploadTicket = z.infer<typeof EvidenceUploadTicket>;

/**
 * A session and everything recorded in it.
 *
 * The steps are the stored rows, verbatim and ordered by `ordinal` — their `evidence` entries
 * carry storage keys and content hashes, exactly as persisted. `evidence` resolves each of those
 * keys to a signed URL once, rather than rewriting the steps: the timeline a console renders and
 * the timeline an audit reads are then the same bytes, and the hash still verifies against them.
 */
export const SessionTimeline = contract(
  'SessionTimeline',
  z
    .strictObject({
      session: Session,
      steps: z.array(SessionStep).describe('Every recorded step, ordered by ordinal.'),
      evidence: z
        .array(SignedEvidence)
        .describe('One entry per distinct storage key referenced by the steps.'),
    })
    .describe('A session with its ordered steps and retrievable evidence.'),
);
export type SessionTimeline = z.infer<typeof SessionTimeline>;
