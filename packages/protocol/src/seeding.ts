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
 * Gateway ↔ indexer: the UI adapter's job boundary.
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
 * Work for the indexer's seed worker: drive a real form, or drive a real delete flow.
 *
 * The UI adapter runs on the indexer rather than in the gateway because that is where the things
 * it needs already are — Playwright, `packages/fingerprint`, and the per-application auth profiles
 * a background browser has to apply to be logged in at all (docs/TEST-DATA-ENGINE.md § 4). The
 * gateway owns the chain, the policy and the ledger; it does not own a browser.
 *
 * Both variants carry ids rather than data. The worker loads the memory version's elements itself,
 * which keeps this message small and — more to the point — keeps element fingerprints out of a
 * Redis stream.
 */
export const UiSeedJob = contract(
  'UiSeedJob',
  z
    .discriminatedUnion('operation', [
      z
        .strictObject({
          operation: z.literal('create'),
          jobId: Uuid,
          tenantId: Uuid,
          applicationId: Uuid,
          memoryVersionId: Uuid,
          sessionId: Uuid,
          planId: Uuid,
          nodeId: NonEmptyString,
          entity: NonEmptyString,
          /** The indexed form, `screen.component`, whose controls share its key prefix. */
          form: NonEmptyString,
          route: RoutePattern,
          values: z.array(UiSeedFieldValue).min(1),
          /** Wall-clock ceiling. A UI materialization is seconds, not minutes. */
          deadlineMs: LatencyMs,
        })
        .meta({
          title: 'UiSeedCreateJob',
          description: 'Fill and submit the real create form, then verify the record is reachable.',
        }),
      z
        .strictObject({
          operation: z.literal('revert'),
          jobId: Uuid,
          tenantId: Uuid,
          applicationId: Uuid,
          memoryVersionId: Uuid,
          entity: NonEmptyString,
          /** The indexed delete control, whose screen supplies the route the record lives on. */
          flow: ElementKey,
          /** The record's own identifier, substituted into that route's dynamic segment. */
          externalRef: NonEmptyString,
          deadlineMs: LatencyMs,
        })
        .meta({
          title: 'UiSeedRevertJob',
          description: 'Drive the indexed delete flow for one seeded record.',
        }),
    ])
    .describe('A UI adapter job: create a record through the real form, or delete one.'),
);
export type UiSeedJob = z.infer<typeof UiSeedJob>;

/**
 * What the worker did.
 *
 * `externalRef` is read back from where the application landed after submit — the identifier
 * segment of the detail route it redirected to. That is both the verification § 4 asks for
 * ("post-submit assertion on the resulting detail route") and the only handle the ledger will
 * have on the record, so a create that cannot produce one is a failure even if the form accepted
 * it: a record nobody can name is a record nobody can revert.
 */
export const UiSeedResult = contract(
  'UiSeedResult',
  z
    .strictObject({
      jobId: Uuid,
      operation: z.enum(['create', 'revert']),
      outcome: z.enum(['succeeded', 'failed']),
      /** The created record's identifier. Null on failure, and on every revert. */
      externalRef: NonEmptyString.nullable(),
      /** Where the application landed after submitting. Null on failure, and on every revert. */
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
        result.operation !== 'create' ||
        result.outcome !== 'succeeded' ||
        (result.externalRef !== null && result.detailPath !== null),
      {
        error: 'a created record must be identifiable and reachable, or it cannot be reverted',
        path: ['externalRef'],
      },
    )
    .describe('The outcome of one UI adapter job, with the identifier it read back.'),
);
export type UiSeedResult = z.infer<typeof UiSeedResult>;
