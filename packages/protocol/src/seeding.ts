import { z } from 'zod';

import { CompositionResponse, ExistingRecord } from './composition.js';
import { MaterializationResult, MaterializerKind, SeedLedgerEntry } from './data.js';
import {
  ElementKey,
  IsoDateTime,
  JsonPayload,
  LatencyMs,
  NonEmptyString,
  RoutePath,
  RoutePattern,
  Uuid,
} from './primitives.js';
import { contract } from './registry.js';
import { RuntimeState } from './runtime.js';

/**
 * The seeding boundary — extension ↔ gateway, and gateway ↔ indexer.
 *
 * `composition.ts` describes what the *composer* is asked and what it concludes. This module
 * describes everything either side of it: how a tester asks for a precondition, what the preview
 * card is given to render, what approval sends back, and how a record is undone. Composition
 * proposes; only the schemas here can cause a write to a customer's application.
 *
 * ## Nothing here creates a record without an approved plan
 *
 * docs/TEST-DATA-ENGINE.md § 6 makes seeding action class `S`: never speculative, never silent.
 * The shape of {@link SeedExecuteRequest} is what makes that structural rather than procedural —
 * it names a plan the gateway already holds and cannot carry one, so there is no request in this
 * contract that both describes a record and creates it. A tester who has not seen a preview has
 * no plan id to approve.
 *
 * ## The preview is a promise about what will happen
 *
 * § 4: "Never silently degrade... If the API adapter created the record, client-side validation
 * was never exercised, and the tester needs to know that." So {@link SeedNodePreview} carries the
 * adapter that *will* run and whether the record can be removed afterwards, before anything is
 * written — a tester deciding whether to seed an unremovable record deserves to know up front,
 * not to find out in the ledger.
 */

/**
 * How a record will be removed, decided before it is created.
 *
 * The mirror of {@link InverseOperation}, and deliberately not the same schema. An inverse
 * operation is concrete — it names the path or the flow that will run — and half of that is not
 * knowable until the record exists and has an identifier. What *is* knowable beforehand is
 * whether a delete path exists at all, and that is the fact the preview turns on.
 *
 * `kind` mirrors the four discriminants of {@link InverseOperation}: an adapter, or `none`.
 */
export const SeedRevertPlan = contract(
  'SeedRevertPlan',
  z
    .strictObject({
      revertible: z.boolean(),
      kind: z.enum(['api', 'ui', 'fixture', 'none']),
      /**
       * Plain language, and shown in the preview verbatim: "drives the indexed delete flow on
       * /orders/:id", or "no delete path was indexed for Order — this record will remain".
       */
      detail: NonEmptyString,
    })
    .refine((plan) => plan.revertible === (plan.kind !== 'none'), {
      error: 'a revertible plan must name an adapter, and `none` must not claim to be revertible',
      path: ['revertible'],
    })
    .describe('Whether a record will be removable after it is created, and by what.'),
);
export type SeedRevertPlan = z.infer<typeof SeedRevertPlan>;

/**
 * One node of a plan, as the preview card renders it.
 *
 * A plan is a graph, so the preview is a list: "a customer with an overdue invoice" creates an
 * Account and an Invoice, and a tester approving that is approving two records, possibly through
 * two different adapters. Flattening it to one summary would hide the second write.
 */
export const SeedNodePreview = contract(
  'SeedNodePreview',
  z
    .strictObject({
      nodeId: NonEmptyString,
      entity: NonEmptyString,
      mode: z.enum(['create', 'reuse_existing']),
      /** Null exactly when the node is reused: nothing is created, so no adapter runs. */
      adapter: MaterializerKind.nullable(),
      /**
       * Why this adapter and not another — "the API materializer has not been verified in 9
       * days, so the UI form will run instead". A tester reading a preview that silently chose
       * the second-best adapter would draw the wrong conclusion about what the test covered.
       */
      adapterReason: NonEmptyString,
      revert: SeedRevertPlan,
    })
    .refine((preview) => (preview.mode === 'reuse_existing') === (preview.adapter === null), {
      error: 'a created node names the adapter that will run; a reused node names none',
      path: ['adapter'],
    })
    .describe('One record the tester is being asked to approve, and how it will be written.'),
);
export type SeedNodePreview = z.infer<typeof SeedNodePreview>;

/**
 * Asking for a precondition. Writes nothing.
 *
 * The memory version is absent on purpose, unlike {@link SessionOpenRequest}: it is read from the
 * session server-side. A plan composed against one version and materialized against another would
 * fill a form that no longer exists, and the caller has no reason to be able to express that.
 */
export const SeedPlanRequest = contract(
  'SeedPlanRequest',
  z
    .strictObject({
      sessionId: Uuid,
      applicationId: Uuid,
      /** What the tester said. Passed through to the composer's parser unchanged. */
      utterance: NonEmptyString,
      /** Where the tester is. Scopes which entity an unqualified utterance is about. */
      runtimeState: RuntimeState,
      /**
       * Records a reference may resolve to, harvested by the extension from the tester's own
       * session in the attached tab.
       *
       * Empty is a supported answer and means every reference must be created, which yields a
       * larger graph rather than a fabricated foreign key. Nothing here is persisted — see
       * {@link ExistingRecord}.
       */
      existingRecords: z.array(ExistingRecord),
      /** Sampling seed, forwarded to the composer. Null draws from entropy. */
      seed: z.int().nullable(),
    })
    .describe('Compose a plan for one utterance. Nothing is created.'),
);
export type SeedPlanRequest = z.infer<typeof SeedPlanRequest>;

/**
 * The composed plan, plus what materializing it would do.
 *
 * `planId` and `preview` are populated only for a `planned` outcome — a conflict and a refusal
 * are answers, not failures, and both travel back inside {@link CompositionResponse} with the
 * explanation the tester is shown.
 *
 * The plan itself is *not* returned for the caller to hand back later. The gateway holds it until
 * `expiresAt`, so approval names an id rather than carrying a payload that could have been edited
 * in between.
 */
export const SeedPlanResponse = contract(
  'SeedPlanResponse',
  z
    .strictObject({
      composition: CompositionResponse,
      /** Null unless the composer produced a plan. */
      planId: Uuid.nullable(),
      /** One entry per plan node, in materialization order. Empty unless a plan was produced. */
      preview: z.array(SeedNodePreview),
      /** When the held plan lapses. Approving after this must re-plan against fresh memory. */
      expiresAt: IsoDateTime.nullable(),
    })
    .refine(
      (response) =>
        (response.composition.outcome.kind === 'planned') === (response.planId !== null),
      {
        error: 'a planned outcome is held under an id; a conflict or refusal holds nothing',
        path: ['planId'],
      },
    )
    .refine((response) => (response.planId === null) === (response.expiresAt === null), {
      error: 'a held plan expires; an unheld one has no expiry',
      path: ['expiresAt'],
    })
    .describe('A composed plan awaiting approval, or the conflict or refusal that replaced it.'),
);
export type SeedPlanResponse = z.infer<typeof SeedPlanResponse>;

/**
 * Approval. The only request in the contract that writes to the app under test.
 *
 * Carries no plan — just the id of one the gateway composed and is holding. That is the whole
 * point: a client cannot approve a record the tester never saw, because the bytes that were
 * previewed are the bytes that get materialized.
 *
 * `approvedAt` is the tester's own approval instant, recorded in the audit log alongside the
 * server's. It is evidence, not authority: the gateway checks its own clock against `expiresAt`.
 */
export const SeedExecuteRequest = contract(
  'SeedExecuteRequest',
  z
    .strictObject({
      sessionId: Uuid,
      planId: Uuid,
      approvedAt: IsoDateTime,
    })
    .describe('Execute a previously previewed plan. Requires explicit tester approval.'),
);
export type SeedExecuteRequest = z.infer<typeof SeedExecuteRequest>;

/**
 * What materialization did, and what can now be undone.
 *
 * `result` carries every rung of the fallback chain including the ones that failed; `ledger` is
 * the durable half — one entry per record that exists in the customer's application as a result.
 * A failed materialization returns a result with no ledger entries rather than an error, because
 * the attempts are the answer: which adapter was tried, and the concrete reason each one failed.
 */
export const SeedExecuteResponse = contract(
  'SeedExecuteResponse',
  z
    .strictObject({
      result: MaterializationResult,
      /** One per created record, in materialization order. Empty when nothing was created. */
      ledger: z.array(SeedLedgerEntry),
    })
    .describe('The outcome of materializing an approved plan, with the ledger it wrote.'),
);
export type SeedExecuteResponse = z.infer<typeof SeedExecuteResponse>;

/**
 * Undoing seeded records — one, or everything a session created.
 *
 * The two scopes are the ones a tester actually asks for: "remove that order" and "clean up after
 * me". A multi-entity graph reverts in reverse dependency order within either scope, which is why
 * the session scope is a scope rather than a client-side loop over entries.
 */
export const SeedRevertRequest = contract(
  'SeedRevertRequest',
  z
    .discriminatedUnion('scope', [
      z.strictObject({ scope: z.literal('entry'), ledgerEntryId: Uuid }).meta({
        title: 'SeedRevertEntry',
        description: 'Revert one seeded record.',
      }),
      z.strictObject({ scope: z.literal('session'), sessionId: Uuid }).meta({
        title: 'SeedRevertSession',
        description: 'Revert every outstanding record a session seeded, newest first.',
      }),
    ])
    .describe('Revert one seeded record, or everything a session seeded.'),
);
export type SeedRevertRequest = z.infer<typeof SeedRevertRequest>;

/**
 * What became of one ledger entry.
 *
 * `not_revertible` is separated from `failed` because they call for different things from the
 * tester. A failure can be retried; an entry whose inverse operation is `none` never had a delete
 * path, and retrying will not grow one — the record has to be removed by hand, and saying so is
 * more useful than a retry button that cannot work.
 */
export const SeedRevertOutcome = contract(
  'SeedRevertOutcome',
  z
    .strictObject({
      ledgerEntryId: Uuid,
      entity: NonEmptyString,
      externalRef: NonEmptyString,
      outcome: z.enum(['reverted', 'failed', 'not_revertible', 'already_reverted']),
      /** Concrete, and populated for every outcome except `reverted`. */
      reason: NonEmptyString.nullable(),
    })
    .refine((outcome) => (outcome.outcome === 'reverted') === (outcome.reason === null), {
      error: 'every outcome other than `reverted` states its reason',
      path: ['reason'],
    })
    .describe('What became of one ledger entry when a revert ran.'),
);
export type SeedRevertOutcome = z.infer<typeof SeedRevertOutcome>;

/** The result of a revert, entry by entry. Partial success is normal and is reported as such. */
export const SeedRevertResponse = contract(
  'SeedRevertResponse',
  z
    .strictObject({
      /** In the order they were reverted: reverse dependency order within the scope. */
      outcomes: z.array(SeedRevertOutcome),
      durationMs: LatencyMs,
    })
    .describe('Outcome of a revert, one entry at a time, in reverse dependency order.'),
);
export type SeedRevertResponse = z.infer<typeof SeedRevertResponse>;

/* -------------------------------------------------------------------------------------------
 * Gateway ↔ indexer: the adapters' job boundary.
 * ---------------------------------------------------------------------------------------- */

/**
 * One control to fill, named by the element key the form observer minted for it.
 *
 * The key, not a selector: the worker resolves it through `packages/fingerprint` against the live
 * form, which is the same resolver the runtime uses on the same memory. CLAUDE.md rule #4 —
 * a second implementation here would drift from the one the tester's commands go through, and the
 * adapter would start failing on exactly the forms the runtime handles fine.
 */
export const UiSeedFieldValue = contract(
  'UiSeedFieldValue',
  z
    .strictObject({
      /** The schema's field name, carried for the failure message when the control is gone. */
      field: NonEmptyString,
      controlElementKey: ElementKey,
      value: JsonPayload,
    })
    .describe('One form control to fill, addressed by its indexed element key.'),
);
export type UiSeedFieldValue = z.infer<typeof UiSeedFieldValue>;

/**
 * Which adapter a job is for, and whether it creates or removes.
 *
 * Flat rather than a pair of `adapter` and `operation` fields because it is the discriminant of
 * {@link SeedJob}, and a union discriminated on two keys at once is not a thing Zod can express.
 * The flat form also reads better everywhere it ends up — a log line saying `api_revert` needs no
 * second field to be understood.
 */
export const SeedJobOperation = contract(
  'SeedJobOperation',
  z
    .enum([
      'ui_create',
      'ui_revert',
      'api_create',
      'api_revert',
      'fixture_create',
      'fixture_revert',
    ])
    .describe('Which adapter runs a seed job, and whether it creates or removes a record.'),
);
export type SeedJobOperation = z.infer<typeof SeedJobOperation>;

/** Every seed job carries these, whichever adapter runs it. */
const seedJobIdentity = {
  jobId: Uuid,
  tenantId: Uuid,
  applicationId: Uuid,
  memoryVersionId: Uuid,
  /** Wall-clock ceiling. A UI materialization is seconds; an API replay is milliseconds. */
  deadlineMs: LatencyMs,
};

/** A create job is one node of an approved plan, and says which. */
const seedCreateIdentity = {
  ...seedJobIdentity,
  sessionId: Uuid,
  planId: Uuid,
  nodeId: NonEmptyString,
  entity: NonEmptyString,
};

/** A revert job names the record it is removing, for the message a tester has to act on. */
const seedRevertIdentity = {
  ...seedJobIdentity,
  entity: NonEmptyString,
  externalRef: NonEmptyString,
};

/**
 * Work for the indexer's seed worker: every write WisprTest makes to the app under test.
 *
 * All three adapters run on the indexer rather than in the gateway, because that is where the
 * things they need already are — Playwright, `packages/fingerprint`, the SSRF policy in
 * `crawl/url-policy.ts`, and the per-application auth profiles a background browser has to apply
 * to be logged in at all (docs/TEST-DATA-ENGINE.md § 4). The gateway owns the chain, the policy
 * and the ledger; it does not own a browser, and it must never hold a customer's credential.
 *
 * That is also how the API adapter satisfies § 4's "reuse the tester's live session": the replay
 * is issued from inside the authenticated browser context, sharing its cookie jar, so no
 * credential is copied anywhere to make the request. See ADR 0013.
 *
 * ## The gateway fills the payload; the worker only sends it
 *
 * `MaterializerSpec` for the API adapter holds a `payloadTemplate` with slots. Filling those from
 * the composed record is the gateway's job, because the gateway is what holds the plan — by the
 * time a job reaches this contract the payload is concrete. The same split as the UI adapter,
 * which arrives with values already chosen and only has to find the controls.
 *
 * ## Jobs carry ids, not data
 *
 * The worker loads the memory version's elements itself, which keeps this message small and —
 * more to the point — keeps element fingerprints out of a Redis stream. The API and fixture
 * payloads are the exception and unavoidably so: they *are* the record being written.
 */
export const SeedJob = contract(
  'SeedJob',
  z
    .discriminatedUnion('operation', [
      z
        .strictObject({
          ...seedCreateIdentity,
          operation: z.literal('ui_create'),
          /** The indexed form, `screen.component`, whose controls share its key prefix. */
          form: NonEmptyString,
          route: RoutePattern,
          values: z.array(UiSeedFieldValue).min(1),
        })
        .meta({
          title: 'UiSeedCreateJob',
          description: 'Fill and submit the real create form, then verify the record is reachable.',
        }),
      z
        .strictObject({
          ...seedRevertIdentity,
          operation: z.literal('ui_revert'),
          /** The indexed delete control, whose screen supplies the route it was seen on. */
          flow: ElementKey,
          /**
           * Where the record lives, as read back when it was created.
           *
           * This is what makes a delete unambiguous, and it is not a convenience. An indexed
           * delete control is as often a button on a list row as it is one on a detail page, and
           * a list holds one per record — identical in role, in accessible name and in
           * fingerprint. Choosing between them by score would delete whichever row happened to
           * match best, which is the single worst thing this system can do.
           *
           * The record's own path disambiguates them structurally: the row that links here is the
           * row for this record. It is also how a detail-page delete is addressed, by being the
           * page the worker navigates to.
           */
          detailPath: RoutePath,
        })
        .meta({
          title: 'UiSeedRevertJob',
          description: 'Drive the indexed delete flow for one seeded record.',
        }),
      z
        .strictObject({
          ...seedCreateIdentity,
          operation: z.literal('api_create'),
          method: z.enum(['POST', 'PUT', 'PATCH']),
          /** The observed create path, from `MaterializerSpec`. Resolved against the app's origin. */
          path: NonEmptyString,
          /** The observed template with every slot filled from the composed record. */
          payload: JsonPayload,
          /**
           * The observed detail read, used to prove the record exists.
           *
           * Null when the crawl never saw one, and then the replay cannot verify itself. A
           * materializer that cannot verify never earns a `verifiedAt`, so the chain's staleness
           * rule keeps it behind the UI adapter permanently — which is the honest outcome, not a
           * gap: an unverifiable create is one that may have silently created nothing.
           */
          readBackPath: NonEmptyString.nullable(),
        })
        .meta({
          title: 'ApiSeedCreateJob',
          description: 'Replay the observed create request, then read the record back to verify.',
        }),
      z
        .strictObject({
          ...seedRevertIdentity,
          operation: z.literal('api_revert'),
          /** Concrete, not a pattern: an inverse operation is decided once the id is known. */
          path: NonEmptyString,
        })
        .meta({
          title: 'ApiSeedRevertJob',
          description: 'DELETE the record through the API that created it.',
        }),
      z
        .strictObject({
          ...seedCreateIdentity,
          operation: z.literal('fixture_create'),
          /** The customer's configured seeding endpoint, per `MaterializerSpec`'s fixture variant. */
          command: NonEmptyString,
          payload: JsonPayload,
        })
        .meta({
          title: 'FixtureSeedCreateJob',
          description: "Post the composed record to the customer's sanctioned seeding endpoint.",
        }),
      z
        .strictObject({
          ...seedRevertIdentity,
          operation: z.literal('fixture_revert'),
          command: NonEmptyString,
        })
        .meta({
          title: 'FixtureSeedRevertJob',
          description: "Run the customer's configured teardown for one seeded record.",
        }),
    ])
    .describe('One write to the application under test, for whichever adapter the chain chose.'),
);
export type SeedJob = z.infer<typeof SeedJob>;

/**
 * What the worker did.
 *
 * `externalRef` is the only handle the ledger will ever have on the record, so a create that
 * cannot produce one is a failure even when the write itself was accepted: a record nobody can
 * name is a record nobody can revert. Where it comes from differs by adapter — the identifier
 * segment of the detail route the UI landed on, or the identifier in the API's response body or
 * `Location` header — but the requirement does not.
 *
 * `detailPath` is required only of the UI adapter, which gets it for free by being a browser that
 * ended up somewhere. An API or fixture replay learns an identifier and nothing about where the
 * record is *rendered*; the gateway derives that from the indexed delete flow's route when it
 * needs one, and records `none` when it cannot. Demanding it here would force the worker to
 * invent a path, which is the one thing a delete must never be aimed with.
 */
export const SeedJobResult = contract(
  'SeedJobResult',
  z
    .strictObject({
      jobId: Uuid,
      operation: SeedJobOperation,
      outcome: z.enum(['succeeded', 'failed']),
      /** The created record's identifier. Null on failure, and on every revert. */
      externalRef: NonEmptyString.nullable(),
      /** Where the application landed after submitting. Null outside a successful `ui_create`. */
      detailPath: RoutePath.nullable(),
      /** Concrete, and populated exactly when the job failed. */
      failureReason: NonEmptyString.nullable(),
      durationMs: LatencyMs,
    })
    .refine((result) => (result.outcome === 'failed') === (result.failureReason !== null), {
      error: 'a failed job states why, and a successful one has nothing to explain',
      path: ['failureReason'],
    })
    .refine(
      (result) =>
        !result.operation.endsWith('_create') ||
        result.outcome !== 'succeeded' ||
        result.externalRef !== null,
      {
        error: 'a created record must be identifiable, or nothing can ever revert it',
        path: ['externalRef'],
      },
    )
    .refine(
      (result) =>
        result.operation !== 'ui_create' ||
        result.outcome !== 'succeeded' ||
        result.detailPath !== null,
      {
        error: 'a record created through the UI must be reachable at the path it landed on',
        path: ['detailPath'],
      },
    )
    .describe('The outcome of one seed job, with the identifier it read back.'),
);
export type SeedJobResult = z.infer<typeof SeedJobResult>;
