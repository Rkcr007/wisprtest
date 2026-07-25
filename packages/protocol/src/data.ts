import { z } from 'zod';

import {
  Confidence,
  ElementKey,
  IsoDateTime,
  JsonPayload,
  LatencyMs,
  NonEmptyString,
  RoutePattern,
  SampleSize,
  Uuid,
} from './primitives.js';
import { contract } from './registry.js';

/**
 * The test data engine — schemas learned from an application, and the plans composed against
 * them.
 *
 * Everything here is generic machinery describing per-application knowledge. Per
 * docs/TEST-DATA-ENGINE.md § 1: entity shapes, enum vocabularies, distributions, referential
 * edges, derived rules, predicates and materializers are all *learned at index time and stored*.
 * If a value in this domain is ever hardcoded against a customer's app, the design is wrong.
 *
 * PII: distributions carry shape, range and frequency only. Raw observed values from a
 * customer's records are never persisted here.
 */

/** The field types the schema inference engine can produce. Closed, and deliberately coarse. */
export const FieldType = contract(
  'FieldType',
  z
    .enum([
      'string',
      'text',
      'integer',
      'number',
      'currency',
      'boolean',
      'date',
      'datetime',
      'enum',
      'reference',
      'group',
    ])
    .describe('Inferred type of a field on a learned entity schema.'),
);
export type FieldType = z.infer<typeof FieldType>;

/**
 * Validation limits observed on the control that edits a field: `required`, `pattern`,
 * `min`/`max`/`maxlength` as read from the form during indexing.
 *
 * These are the app's own rules. The solver must satisfy them or the UI materializer will be
 * rejected by the very validation the tester wanted exercised.
 */
export const FieldValueConstraints = contract(
  'FieldValueConstraints',
  z
    .strictObject({
      min: z.number().nullable(),
      max: z.number().nullable(),
      minLength: z.int().min(0).nullable(),
      maxLength: z.int().min(0).nullable(),
      /** Regex source as it appeared in the control's `pattern` attribute. */
      pattern: NonEmptyString.nullable(),
    })
    .describe('Validation limits observed on the control that edits this field.'),
);
export type FieldValueConstraints = z.infer<typeof FieldValueConstraints>;

/**
 * The observed shape of a field's values.
 *
 * Sampling draws from *this application's* distribution so seeded data is indistinguishable
 * from real data — never from faker defaults, which is how seeded records end up failing
 * downstream validation that real records pass.
 */
export const DistributionShape = contract(
  'DistributionShape',
  z
    .discriminatedUnion('kind', [
      z
        .strictObject({
          kind: z.literal('numeric'),
          min: z.number(),
          max: z.number(),
          mean: z.number(),
          stddev: z.number().min(0),
          fit: z.enum(['normal', 'lognormal', 'uniform', 'unknown']),
        })
        .meta({
          title: 'DistributionNumeric',
          description: 'Fitted numeric distribution with the observed range.',
        }),
      z
        .strictObject({
          kind: z.literal('categorical'),
          /** Value → observed relative frequency. The learned enum vocabulary, weighted. */
          frequencies: z.record(z.string(), z.number().min(0).max(1)),
        })
        .meta({
          title: 'DistributionCategorical',
          description: 'Observed vocabulary with relative frequencies.',
        }),
      z
        .strictObject({
          kind: z.literal('string_pattern'),
          /** Shared literal prefix, e.g. `ORD-`. Null when values share none. */
          prefix: NonEmptyString.nullable(),
          minLength: z.int().min(0),
          maxLength: z.int().min(0),
          charset: z.enum(['numeric', 'alpha', 'alphanumeric', 'mixed']),
        })
        .meta({
          title: 'DistributionStringPattern',
          description: 'Learned string shape: prefix, length range and character class.',
        }),
      z
        .strictObject({
          kind: z.literal('temporal'),
          /** Observed range as day offsets from now; negative is in the past. */
          minOffsetDays: z.number(),
          maxOffsetDays: z.number(),
        })
        .meta({
          title: 'DistributionTemporal',
          description: 'Observed date range expressed as offsets from now.',
        }),
    ])
    .describe('The observed shape of a field, by field type family.'),
);
export type DistributionShape = z.infer<typeof DistributionShape>;

/** An observed distribution together with how much evidence stands behind it. */
export const FieldDistribution = contract(
  'FieldDistribution',
  z
    .strictObject({
      shape: DistributionShape,
      sampleSize: SampleSize,
      /** Distinct values seen. A low count on a `string` field usually means it is an enum. */
      distinctCount: z.int().min(0),
    })
    .describe('An observed value distribution and the sample it was computed from.'),
);
export type FieldDistribution = z.infer<typeof FieldDistribution>;

/**
 * A derived-field hypothesis that held for every observed record.
 *
 * The hypothesis space is small and explicit on purpose — sum, count, min, max, date offset,
 * concatenation. Per docs/TEST-DATA-ENGINE.md § 2.3 this is not a program synthesiser and must
 * not become one.
 */
export const DerivedRuleSpec = contract(
  'DerivedRuleSpec',
  z
    .discriminatedUnion('kind', [
      z
        .strictObject({
          kind: z.literal('sum'),
          /** The repeatable group field, e.g. `line_items`. */
          overField: NonEmptyString,
          /** The member field summed, e.g. `amount`. */
          ofField: NonEmptyString,
        })
        .meta({
          title: 'DerivedRuleSum',
          description: 'Field equals the sum of a repeated group.',
        }),
      z
        .strictObject({ kind: z.literal('count'), overField: NonEmptyString })
        .meta({ title: 'DerivedRuleCount', description: 'Field equals the size of a group.' }),
      z
        .strictObject({
          kind: z.literal('min'),
          overField: NonEmptyString,
          ofField: NonEmptyString,
        })
        .meta({ title: 'DerivedRuleMin', description: 'Field equals the minimum over a group.' }),
      z
        .strictObject({
          kind: z.literal('max'),
          overField: NonEmptyString,
          ofField: NonEmptyString,
        })
        .meta({ title: 'DerivedRuleMax', description: 'Field equals the maximum over a group.' }),
      z
        .strictObject({
          kind: z.literal('date_offset'),
          fromField: NonEmptyString,
          offsetDays: z.number(),
        })
        .meta({
          title: 'DerivedRuleDateOffset',
          description: 'Field equals another date shifted by a fixed number of days.',
        }),
      z
        .strictObject({
          kind: z.literal('concat'),
          fields: z.array(NonEmptyString).min(2),
          separator: z.string(),
        })
        .meta({
          title: 'DerivedRuleConcat',
          description: 'Field equals other fields joined by a separator.',
        }),
    ])
    .describe('One derived-field hypothesis from the explicit, closed hypothesis set.'),
);
export type DerivedRuleSpec = z.infer<typeof DerivedRuleSpec>;

/**
 * A derived rule recorded only because it held for *every* observed record. Confidence is a
 * function of sample size, not of how plausible the rule looks.
 */
export const DerivedRule = contract(
  'DerivedRule',
  z
    .strictObject({
      rule: DerivedRuleSpec,
      confidence: Confidence,
      sampleSize: SampleSize,
    })
    .describe('A derived-field rule that held across every observed record.'),
);
export type DerivedRule = z.infer<typeof DerivedRule>;

/**
 * One field of a learned entity, with everything needed to generate a plausible value for it.
 *
 * `referencesEntity` is the referential graph, discovered by matching foreign-key-shaped values
 * across observed collections — never declared.
 */
export const FieldSpec = contract(
  'FieldSpec',
  z
    .strictObject({
      id: Uuid,
      entitySchemaId: Uuid,
      name: NonEmptyString,
      type: FieldType,
      required: z.boolean(),
      /** Non-null when the field is computed; the solver evaluates these last. */
      derivedRule: DerivedRule.nullable(),
      /** Learned vocabulary for `enum` fields. Null for every other type. */
      enumValues: z.array(NonEmptyString).nullable(),
      distribution: FieldDistribution.nullable(),
      /** Target entity name when `type` is `reference`. Null otherwise. */
      referencesEntity: NonEmptyString.nullable(),
      valueConstraints: FieldValueConstraints,
      /** The form control that edits this field, for the UI materializer. Null if API-only. */
      controlElementKey: ElementKey.nullable(),
      /** Values seen for this field must be unique across the collection. */
      unique: z.boolean(),
    })
    .describe('One learned field of an entity, with its type, limits and value distribution.'),
);
export type FieldSpec = z.infer<typeof FieldSpec>;

/** How a materializer creates a record. Priorities are per docs/TEST-DATA-ENGINE.md § 4. */
export const MaterializerKind = contract(
  'MaterializerKind',
  z.enum(['api', 'ui', 'fixture']).describe('Which adapter creates the record.'),
);
export type MaterializerKind = z.infer<typeof MaterializerKind>;

/** The adapter-specific detail of how to create a record of one entity. */
export const MaterializerSpec = contract(
  'MaterializerSpec',
  z
    .discriminatedUnion('kind', [
      z
        .strictObject({
          kind: z.literal('api'),
          method: z.enum(['POST', 'PUT', 'PATCH']),
          path: NonEmptyString,
          /** The observed request body with field slots, filled from the composition plan. */
          payloadTemplate: JsonPayload,
          /** How the replayed request authenticates. Credentials are never stored by us. */
          auth: z.enum(['session', 'bearer', 'none']),
          /** Observed read-back request used to verify creation. Null when none was seen. */
          readBackPath: NonEmptyString.nullable(),
        })
        .meta({
          title: 'MaterializerApi',
          description: 'Replay the observed create request. Fast, but bypasses client validation.',
        }),
      z
        .strictObject({
          kind: z.literal('ui'),
          /** The indexed form, named `screen.component` style, e.g. `orders.create`. */
          form: NonEmptyString,
          route: RoutePattern,
        })
        .meta({
          title: 'MaterializerUi',
          description: 'Drive the real create form. Slower, but exercises real validation.',
        }),
      z
        .strictObject({
          kind: z.literal('fixture'),
          /** Customer-provided seeding endpoint or command, configured in the console. */
          command: NonEmptyString,
        })
        .meta({
          title: 'MaterializerFixture',
          description: 'Customer-sanctioned seeding path. Highest priority when configured.',
        }),
    ])
    .describe('Adapter-specific instructions for creating a record.'),
);
export type MaterializerSpec = z.infer<typeof MaterializerSpec>;

/**
 * A registered materializer with its position in the fallback chain.
 *
 * Verification has a TTL: an API materializer unverified for too long drops below UI in
 * priority until it is re-verified, because a stale replay silently tests nothing.
 */
export const MaterializerDescriptor = contract(
  'MaterializerDescriptor',
  z
    .strictObject({
      id: Uuid,
      entitySchemaId: Uuid,
      spec: MaterializerSpec,
      /** Lower runs first. Fixture 0, API 1, UI 2 by default. */
      priority: z.int().min(0),
      /** Null means never verified; such a materializer may not run ahead of UI. */
      verifiedAt: IsoDateTime.nullable(),
      verificationTtlHours: z.int().min(1),
    })
    .describe('One materializer for an entity, with its priority and verification state.'),
);
export type MaterializerDescriptor = z.infer<typeof MaterializerDescriptor>;

/** The right-hand side of a predicate clause. */
export const PredicateOperand = contract(
  'PredicateOperand',
  z
    .discriminatedUnion('kind', [
      z
        .strictObject({ kind: z.literal('literal'), value: JsonPayload })
        .meta({ title: 'PredicateOperandLiteral', description: 'A fixed value.' }),
      z.strictObject({ kind: z.literal('now'), offsetDays: z.number() }).meta({
        title: 'PredicateOperandNow',
        description: 'Evaluation time, optionally shifted, so predicates stay true over time.',
      }),
    ])
    .describe('Right-hand side of a predicate clause.'),
);
export type PredicateOperand = z.infer<typeof PredicateOperand>;

/** One conjunct of a predicate, e.g. `due_date < now()`. */
export const PredicateClause = contract(
  'PredicateClause',
  z
    .strictObject({
      field: NonEmptyString,
      op: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte']),
      operand: PredicateOperand,
    })
    .describe('One field comparison within a predicate.'),
);
export type PredicateClause = z.infer<typeof PredicateClause>;

/**
 * A named condition over an entity's fields — "overdue", "expired", "high value".
 *
 * Learned during indexing wherever the UI surfaces a named status derived from field values
 * (a badge reading "Overdue" on rows where `due_date < today`), and definable by hand in the
 * console where inference is uncertain. Clauses are conjunctive.
 */
export const PredicateDefinition = contract(
  'PredicateDefinition',
  z
    .strictObject({
      name: NonEmptyString,
      entity: NonEmptyString,
      clauses: z.array(PredicateClause).min(1),
      source: z.enum(['inferred', 'manual']),
      confidence: Confidence,
      sampleSize: SampleSize,
    })
    .describe('A learned or authored named condition over an entity, e.g. "overdue".'),
);
export type PredicateDefinition = z.infer<typeof PredicateDefinition>;

/**
 * Everything learned about one entity of one application, at one memory version.
 *
 * `confidence` gates composition: below the configured threshold the engine refuses and names
 * the missing field rather than guessing, per docs/TEST-DATA-ENGINE.md § 7.
 */
export const EntitySchema = contract(
  'EntitySchema',
  z
    .strictObject({
      id: Uuid,
      memoryVersionId: Uuid,
      entityName: NonEmptyString,
      fields: z.array(FieldSpec),
      materializers: z.array(MaterializerDescriptor),
      predicates: z.array(PredicateDefinition),
      /** Records observed during indexing. Everything below is only as good as this number. */
      observedCount: SampleSize,
      confidence: Confidence,
      createdAt: IsoDateTime,
    })
    .describe('A learned entity: its fields, how to create one, and what is known about it.'),
);
export type EntitySchema = z.infer<typeof EntitySchema>;

/**
 * A parsed requirement from the tester's utterance.
 *
 * The five kinds are exactly those in docs/TEST-DATA-ENGINE.md § 3. Nothing outside this set
 * may be silently approximated: an unparsed fragment is reported, never dropped.
 */
export const Constraint = contract(
  'Constraint',
  z
    .discriminatedUnion('kind', [
      z
        .strictObject({ kind: z.literal('equals'), field: NonEmptyString, value: JsonPayload })
        .meta({ title: 'ConstraintEquals', description: 'Field takes an explicit value.' }),
      z
        .strictObject({
          kind: z.literal('reference'),
          field: NonEmptyString,
          phrase: NonEmptyString,
        })
        .meta({
          title: 'ConstraintReference',
          description: 'Field points at a record named by a phrase, e.g. "for Acme Industrial".',
        }),
      z
        .strictObject({
          kind: z.literal('cardinality'),
          field: NonEmptyString,
          count: z.int().min(0),
        })
        .meta({
          title: 'ConstraintCardinality',
          description: 'A repeated group has a given size, e.g. "three line items".',
        }),
      z
        .strictObject({
          kind: z.literal('comparison'),
          field: NonEmptyString,
          op: z.enum(['gt', 'lt', 'gte', 'lte']),
          value: z.number(),
        })
        .meta({
          title: 'ConstraintComparison',
          description: 'Field satisfies a numeric comparison, e.g. "over $50,000".',
        }),
      z.strictObject({ kind: z.literal('predicate'), name: NonEmptyString }).meta({
        title: 'ConstraintPredicate',
        description: 'A named condition holds, e.g. "overdue" — may span two entities.',
      }),
    ])
    .describe('One parsed requirement from a seeding utterance.'),
);
export type Constraint = z.infer<typeof Constraint>;

/** The full parse of a seeding utterance: which entity, and what must be true of it. */
export const ConstraintSet = contract(
  'ConstraintSet',
  z
    .strictObject({
      entity: NonEmptyString,
      constraints: z.array(Constraint),
      confidence: Confidence,
      /** Fragments the parser could not map. Surfaced to the tester; never dropped silently. */
      unparsedFragments: z.array(NonEmptyString),
    })
    .describe('Parsed constraints for one entity, plus anything the parser could not map.'),
);
export type ConstraintSet = z.infer<typeof ConstraintSet>;

/** Why a field holds the value it does. The vocabulary is closed and ordered by trust. */
export const ProvenanceSource = contract(
  'ProvenanceSource',
  z
    .enum(['requested', 'reference_matched', 'sampled', 'derived', 'predicate_solved', 'default'])
    .describe('How a composed field value was arrived at.'),
);
export type ProvenanceSource = z.infer<typeof ProvenanceSource>;

/**
 * The explanation attached to every composed field.
 *
 * Non-negotiable per docs/TEST-DATA-ENGINE.md § 3: this is what the preview card renders, and
 * it is what makes seeding trustworthy rather than spooky. `explanation` must be specific —
 * "matched from 64 known accounts", not "generated".
 */
export const ProvenanceEntry = contract(
  'ProvenanceEntry',
  z
    .strictObject({
      field: NonEmptyString,
      value: JsonPayload,
      source: ProvenanceSource,
      explanation: NonEmptyString.describe('Human-readable and specific reason for this value.'),
      confidence: Confidence,
    })
    .describe('Why one composed field holds the value it does.'),
);
export type ProvenanceEntry = z.infer<typeof ProvenanceEntry>;

/**
 * One record in a composition plan.
 *
 * `reuse_existing` is as important as `create`: "an order for Acme Industrial" should point at
 * the real Acme record, and only create a new account when the utterance demands novelty.
 */
export const CompositionNode = contract(
  'CompositionNode',
  z
    .strictObject({
      /** Plan-local identifier, referenced by edges and by the materialization order. */
      nodeId: NonEmptyString,
      entity: NonEmptyString,
      entitySchemaId: Uuid,
      mode: z.enum(['create', 'reuse_existing']),
      /** The existing record's external reference. Non-null exactly when reusing. */
      existingExternalRef: NonEmptyString.nullable(),
      fields: z.record(z.string(), JsonPayload),
      provenance: z.array(ProvenanceEntry),
    })
    .describe('One record to create or reuse as part of a plan.'),
);
export type CompositionNode = z.infer<typeof CompositionNode>;

/**
 * A dependency between two plan nodes. `fromNodeId` needs `toNodeId` to exist first, and
 * `viaField` is the field on `from` that will hold `to`'s identifier once it does.
 */
export const CompositionEdge = contract(
  'CompositionEdge',
  z
    .strictObject({
      fromNodeId: NonEmptyString,
      toNodeId: NonEmptyString,
      viaField: NonEmptyString,
    })
    .describe('A dependency edge: `from` cannot be created until `to` exists.'),
);
export type CompositionEdge = z.infer<typeof CompositionEdge>;

/**
 * The composer's output: a DAG of records, never a single record.
 *
 * "A customer with an overdue invoice" produces Account → Invoice in that order. Building for
 * one record and retrofitting multi-entity later is a rewrite, so the graph is the shape from
 * the start even when it holds exactly one node.
 *
 * A plan writes nothing. Materialization is the gateway's job, after explicit approval.
 */
export const CompositionPlan = contract(
  'CompositionPlan',
  z
    .strictObject({
      id: Uuid,
      tenantId: Uuid,
      sessionId: Uuid,
      memoryVersionId: Uuid,
      /** The node the tester actually asked for; the rest exist to make it satisfiable. */
      rootNodeId: NonEmptyString,
      nodes: z.array(CompositionNode).min(1),
      edges: z.array(CompositionEdge),
      /** Topologically sorted node ids. The gateway materializes strictly in this order. */
      materializationOrder: z.array(NonEmptyString).min(1),
      constraintSet: ConstraintSet,
      createdAt: IsoDateTime,
    })
    .describe('A dependency-ordered graph of records to create, with per-field provenance.'),
);
export type CompositionPlan = z.infer<typeof CompositionPlan>;

/**
 * How to undo a seeded record. Exactly the four cases from docs/TEST-DATA-ENGINE.md § 5.
 *
 * `none` is a real answer, not a failure. When no delete path exists the preview must say so
 * *before* creating — a tester deciding whether to seed an unremovable record deserves to know.
 */
export const InverseOperation = contract(
  'InverseOperation',
  z
    .discriminatedUnion('kind', [
      z
        .strictObject({
          kind: z.literal('api'),
          method: z.literal('DELETE'),
          path: NonEmptyString,
        })
        .meta({ title: 'InverseOperationApi', description: 'Delete via the observed API.' }),
      z
        .strictObject({ kind: z.literal('ui'), flow: NonEmptyString })
        .meta({ title: 'InverseOperationUi', description: 'Drive the indexed delete flow.' }),
      z.strictObject({ kind: z.literal('fixture'), command: NonEmptyString }).meta({
        title: 'InverseOperationFixture',
        description: "Run the customer's configured teardown command.",
      }),
      z.strictObject({ kind: z.literal('none'), reason: NonEmptyString }).meta({
        title: 'InverseOperationNone',
        description: 'No delete path exists; the reason is shown in the preview before writing.',
      }),
    ])
    .describe('How a seeded record can be removed, or why it cannot be.'),
);
export type InverseOperation = z.infer<typeof InverseOperation>;

/**
 * One rung of the fallback chain, recorded whether it succeeded or not.
 *
 * Per docs/TEST-DATA-ENGINE.md § 4, degradation is never silent: if the API adapter failed and
 * UI ran instead, the tester exercised different code, and the ledger has to show it.
 */
export const MaterializationAttempt = contract(
  'MaterializationAttempt',
  z
    .strictObject({
      adapter: MaterializerKind,
      outcome: z.enum(['succeeded', 'failed', 'skipped']),
      /** Concrete reason for a failure or skip, e.g. "api materializer unverified for 9 days". */
      reason: NonEmptyString.nullable(),
      durationMs: LatencyMs,
    })
    .describe('One adapter attempt within the fallback chain.'),
);
export type MaterializationAttempt = z.infer<typeof MaterializationAttempt>;

/** One record that actually exists in the app under test as a result of materialization. */
export const MaterializedRecord = contract(
  'MaterializedRecord',
  z
    .strictObject({
      nodeId: NonEmptyString,
      entity: NonEmptyString,
      /** The app's own identifier for the record, e.g. `ORD-4903`. */
      externalRef: NonEmptyString,
      payload: JsonPayload,
      inverseOp: InverseOperation,
    })
    .describe('A record created in the application under test, and how to remove it.'),
);
export type MaterializedRecord = z.infer<typeof MaterializedRecord>;

/** The result of running a plan through the materializer chain. Verified, or explained. */
export const MaterializationResult = contract(
  'MaterializationResult',
  z
    .strictObject({
      planId: Uuid,
      outcome: z.enum(['created', 'failed']),
      /** The adapter that actually created the records. Always shown to the tester. */
      adapterUsed: MaterializerKind.nullable(),
      /** Every rung tried, in order, including the ones that failed. */
      attempts: z.array(MaterializationAttempt).min(1),
      records: z.array(MaterializedRecord),
      /** Null until the read-back verification succeeds. */
      verifiedAt: IsoDateTime.nullable(),
      /** Populated when `outcome` is `failed`; concrete, not "something went wrong". */
      failureReason: NonEmptyString.nullable(),
      durationMs: LatencyMs,
    })
    .describe('Outcome of materializing a plan, including the full fallback chain.'),
);
export type MaterializationResult = z.infer<typeof MaterializationResult>;

/**
 * The audit record for one seeded entity. Reversibility is the adoption gate: testers will not
 * adopt a tool that quietly fills staging with garbage.
 */
export const SeedLedgerEntry = contract(
  'SeedLedgerEntry',
  z
    .strictObject({
      id: Uuid,
      tenantId: Uuid,
      sessionId: Uuid,
      planId: Uuid,
      nodeId: NonEmptyString,
      entitySchemaId: Uuid,
      entity: NonEmptyString,
      externalRef: NonEmptyString,
      adapterUsed: MaterializerKind,
      payload: JsonPayload,
      provenance: z.array(ProvenanceEntry),
      inverseOp: InverseOperation,
      createdAt: IsoDateTime,
      /** Non-null once reverted. Multi-entity graphs revert in reverse dependency order. */
      revertedAt: IsoDateTime.nullable(),
    })
    .describe('Ledger record of one seeded entity, with its provenance and inverse operation.'),
);
export type SeedLedgerEntry = z.infer<typeof SeedLedgerEntry>;
