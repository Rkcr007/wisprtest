import { z } from 'zod';

import {
  CompositionPlan,
  Constraint,
  ConstraintSet,
  EntitySchema,
  ProvenanceEntry,
} from './data.js';
import { Confidence, IsoDateTime, JsonPayload, NonEmptyString, Uuid } from './primitives.js';
import { contract } from './registry.js';
import { RuntimeState } from './runtime.js';

/**
 * The composer's boundary — what the gateway sends it, and what comes back.
 *
 * `apps/composer` is stateless (docs/ARCHITECTURE.md § 5): it holds no database handle, reads no
 * memory version, and writes nothing anywhere. Everything it reasons over arrives in the request
 * and everything it concludes leaves in the response. That is the property these schemas exist to
 * make structural rather than aspirational — a composer that needed to fetch something would need
 * a field here to say what.
 *
 * ## Composing writes nothing
 *
 * A {@link CompositionOutcome} is a *proposal*. docs/TEST-DATA-ENGINE.md § 6 requires seeding to be
 * previewed and approved before anything is created, so the plan is rendered to a human, and only
 * an explicit approval sends it to the gateway to materialize. Nothing in this module can create a
 * record.
 *
 * ## Three answers, and refusing is one of them
 *
 * The outcome is a union rather than a plan-or-error, because two of the three answers are not
 * failures. § 7's failure table says an unsatisfiable constraint set must "report the conflict in
 * plain language; never silently drop a constraint", and a schema too uncertain to compose must
 * "refuse with the specific missing field". Both are things the engine *knows*, and modelling them
 * as errors would flatten them into a string.
 */

/**
 * A real record in the application under test, offered to the solver.
 *
 * This is the one place in the contract where a customer's own data appears, and it is worth
 * being explicit about why and about what constrains it.
 *
 * Reference resolution cannot work without it. "An order for Acme Industrial" is only satisfiable
 * if the solver can find out that Acme Industrial exists and what its identifier is, and § 3 is
 * explicit that a reference should "prefer an existing real record" over inventing one — a seeded
 * order pointing at a fabricated account is not a test fixture, it is a broken row.
 *
 * What holds regardless:
 *
 * - **Nothing here is persisted.** These records travel with one request, are read by the solver,
 *   and are gone. They are never written to memory, which is what CLAUDE.md § "PII rule" governs:
 *   Product Memory stores structure, never content.
 * - **Nothing here reaches a model provider.** The constraint parser is given the utterance and
 *   the learned vocabularies, never the records; reference *resolution* runs locally, after
 *   parsing. `apps/composer` asserts this in a test.
 */
export const ExistingRecord = contract(
  'ExistingRecord',
  z
    .strictObject({
      entity: NonEmptyString,
      /** The application's own identifier, e.g. `ACC-1001`. What a reference field is set to. */
      externalRef: NonEmptyString,
      /** Human-readable name, matched against a reference phrase. Null when the record has none. */
      label: NonEmptyString.nullable(),
      /** The record's fields, as the application returned them. */
      fields: z.record(z.string(), JsonPayload),
    })
    .describe('An existing record in the application under test, for reference resolution.'),
);
export type ExistingRecord = z.infer<typeof ExistingRecord>;

/**
 * A learned mapping from a phrasing to the constraints it means.
 *
 * The parser's half of the write-back loop CLAUDE.md § "Resolution tiers" describes for the
 * resolver: a phrasing that had to reach T2 once is stored, so the next tester who says it is
 * answered from the table. Without the write-back, T2 is just a slower parser.
 *
 * The composer is stateless, so it *returns* these rather than saving them; persisting them is the
 * gateway's job, exactly as it is for element aliases.
 */
export const ConstraintAlias = contract(
  'ConstraintAlias',
  z
    .strictObject({
      /** The normalised fragment this alias explains, e.g. `high value`. */
      phrase: NonEmptyString,
      entity: NonEmptyString,
      /** What the fragment means. Empty is not allowed — an alias that maps to nothing is noise. */
      constraints: z.array(Constraint).min(1),
      source: z.enum(['indexed', 't2_writeback', 'manual']),
      confidence: Confidence,
    })
    .describe('A learned phrase-to-constraint mapping, so a phrasing parsed once is free after.'),
);
export type ConstraintAlias = z.infer<typeof ConstraintAlias>;

/** Everything the composer needs to turn one utterance into a plan. */
export const CompositionRequest = contract(
  'CompositionRequest',
  z
    .strictObject({
      tenantId: Uuid,
      sessionId: Uuid,
      memoryVersionId: Uuid,
      /** What the tester said. The only free text the composer parses. */
      utterance: NonEmptyString,
      /**
       * The learned schemas the plan may draw on.
       *
       * More than one because a plan is a graph: "a customer with an overdue invoice" needs
       * `Invoice` to know what overdue means and `Account` to have something to attach it to.
       */
      schemas: z.array(EntitySchema).min(1),
      /** Where the tester is. Scopes which entity an unqualified utterance is about. */
      runtimeState: RuntimeState,
      /** Records a reference may resolve to. Empty means every reference must be created. */
      existingRecords: z.array(ExistingRecord),
      /** Phrasings already learned, so a repeat costs no model call. */
      aliases: z.array(ConstraintAlias),
      /** Evaluation time. Supplied rather than read from the clock so a plan is reproducible. */
      now: IsoDateTime,
      /**
       * Seed for value sampling. Null draws from entropy.
       *
       * Present so a test can assert the *same* plan twice. Sampling is the only nondeterminism
       * in the composer, and an assertion about a sampled value is otherwise a coin toss.
       */
      seed: z.int().nullable(),
    })
    .describe('One utterance, the schemas it may draw on, and the state it was spoken in.'),
);
export type CompositionRequest = z.infer<typeof CompositionRequest>;

/**
 * One side of a conflict: something the plan was asked for, or something the schema forbids.
 *
 * Both halves are needed to explain a collision. "Over £50,000 and under £1,000" is two
 * constraints; "status must be `escalated`" against a field whose learned vocabulary has three
 * other values is a constraint against the schema, and reporting only the constraint would leave
 * the tester guessing what it collided with.
 */
export const ConflictSide = contract(
  'ConflictSide',
  z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('constraint'), constraint: Constraint }).meta({
        title: 'ConflictSideConstraint',
        description: 'Something the utterance asked for.',
      }),
      z
        .strictObject({
          kind: z.literal('schema'),
          field: NonEmptyString,
          /** What the schema says, in words: "accepts only Draft, Pending approval, Approved". */
          detail: NonEmptyString,
        })
        .meta({
          title: 'ConflictSideSchema',
          description: 'Something the learned schema forbids.',
        }),
    ])
    .describe('One half of an unsatisfiable pair.'),
);
export type ConflictSide = z.infer<typeof ConflictSide>;

/**
 * Two requirements that cannot both hold.
 *
 * § 7: "Unsatisfiable constraints → report the conflict in plain language; never silently drop a
 * constraint." Dropping one is the tempting implementation and the worst one: the tester gets a
 * record, believes it satisfies what they asked for, and tests the wrong thing.
 */
export const ConstraintConflict = contract(
  'ConstraintConflict',
  z
    .strictObject({
      left: ConflictSide,
      right: ConflictSide,
      /** The field they collide on, when they collide on one. */
      field: NonEmptyString.nullable(),
      /** Plain language, and specific enough to act on. Rendered straight to the tester. */
      explanation: NonEmptyString,
    })
    .describe('Two requirements that cannot both be satisfied, and why.'),
);
export type ConstraintConflict = z.infer<typeof ConstraintConflict>;

/**
 * What the composer concluded. Exactly one of three, and only the first produces a plan.
 *
 * `refused` is the § 7 case where the schema itself is too uncertain: the engine names the fields
 * it does not understand well enough to fill, rather than guessing and producing a record the
 * application rejects for reasons nobody can trace.
 */
export const CompositionOutcome = contract(
  'CompositionOutcome',
  z
    .discriminatedUnion('kind', [
      z
        .strictObject({
          kind: z.literal('planned'),
          plan: CompositionPlan,
          /** New phrasings this parse learned, for the gateway to persist. */
          aliasWriteBacks: z.array(ConstraintAlias),
        })
        .meta({
          title: 'CompositionPlanned',
          description: 'A dependency-ordered plan, awaiting human approval. Nothing was created.',
        }),
      z
        .strictObject({
          kind: z.literal('conflict'),
          constraintSet: ConstraintSet,
          conflict: ConstraintConflict,
        })
        .meta({
          title: 'CompositionConflicted',
          description: 'The utterance asked for two things that cannot both be true.',
        }),
      z
        .strictObject({
          kind: z.literal('refused'),
          constraintSet: ConstraintSet,
          entity: NonEmptyString,
          /** The specific fields the schema does not describe well enough to fill. */
          missingFields: z.array(NonEmptyString),
          reason: NonEmptyString,
        })
        .meta({
          title: 'CompositionRefused',
          description: 'Schema confidence too low to compose; the missing fields are named.',
        }),
    ])
    .describe(
      "The composer's answer: a plan, a conflict, or a refusal that names what is missing.",
    ),
);
export type CompositionOutcome = z.infer<typeof CompositionOutcome>;

/**
 * The response envelope: the outcome, plus what it cost and how the utterance was read.
 *
 * `constraintSet` is here as well as inside the conflict and refusal variants because a *planned*
 * outcome needs it too — the preview shows what the composer understood the tester to have asked
 * for, and `unparsedFragments` is how a tester finds out that half their sentence was ignored.
 */
export const CompositionResponse = contract(
  'CompositionResponse',
  z
    .strictObject({
      constraintSet: ConstraintSet,
      outcome: CompositionOutcome,
      /** Which tier parsed the utterance. `T2` means a model was called and an alias was learned. */
      parseTier: z.enum(['T0', 'T1', 'T2']),
      /** End-to-end composition time. Budgeted at 1.2 s p95 in CLAUDE.md § "Performance budgets". */
      durationMs: z.number().min(0),
    })
    .describe("The composer's reply: how the utterance was read, and what it concluded."),
);
export type CompositionResponse = z.infer<typeof CompositionResponse>;

/**
 * Re-exported so a consumer of the composer boundary does not have to know that provenance is
 * defined alongside the schemas rather than alongside the plan that carries it.
 */
export type { ProvenanceEntry };
