import { z } from 'zod';

import { Constraint, MaterializerKind } from './data.js';
import {
  Confidence,
  ElementKey,
  LatencyMs,
  NonEmptyString,
  RedactedText,
  StateFingerprint,
  Uuid,
} from './primitives.js';
import { contract } from './registry.js';
import { ActionClass, Tier } from './vocabulary.js';

/**
 * The typed error taxonomy.
 *
 * CLAUDE.md § "Conventions" forbids throwing a bare `Error` anywhere in the system. Every
 * failure that crosses a process boundary is one of the variants below, discriminated on
 * `code`, so a consumer can exhaustively handle it and the gateway can map it to a status
 * code in one place.
 *
 * Three rules hold for every variant:
 *
 * - `message` is plain language written for a tester, not a stack trace. Where the docs
 *   demand specificity — "report the conflict in plain language; never silently drop a
 *   constraint" — the variant carries the structured detail as well as the sentence.
 * - `retryable` says whether the same request could succeed unchanged. It is the caller's
 *   only input to a retry decision; nothing infers retryability from the code.
 * - No variant carries raw element text or raw field values. Redacted forms only.
 */

/**
 * Every error code in the taxonomy.
 *
 * Kept as its own enum so consumers can hold a code without holding a whole error, and so the
 * console can render a code filter. A test asserts this list and the {@link WisprError} union
 * stay in exact correspondence — adding a variant without a code, or vice versa, fails the
 * build.
 */
export const WisprErrorCode = contract(
  'WisprErrorCode',
  z
    .enum([
      'resolution_ambiguous',
      'resolution_not_found',
      'resolution_timeout',
      'memory_version_mismatch',
      'memory_snapshot_unavailable',
      'action_confirmation_required',
      'action_target_stale',
      'action_dispatch_failed',
      'constraint_unsatisfiable',
      'schema_confidence_too_low',
      'reference_target_missing',
      'uniqueness_exhausted',
      'materializer_unavailable',
      'materialization_failed',
      'seeding_forbidden',
      'drift_approval_required',
      'unauthorized',
      'forbidden',
      'rate_limited',
      'validation_failed',
      'internal',
    ])
    .describe('Discriminator of the WisprError union.'),
);
export type WisprErrorCode = z.infer<typeof WisprErrorCode>;

/** One field-level problem inside a `validation_failed` error. */
export const ValidationIssue = contract(
  'ValidationIssue',
  z
    .strictObject({
      /** Dotted path to the offending property, e.g. `nodes.0.fields.amount`. */
      path: NonEmptyString,
      message: NonEmptyString,
    })
    .describe('One field-level validation problem.'),
);
export type ValidationIssue = z.infer<typeof ValidationIssue>;

export const WisprError = contract(
  'WisprError',
  z
    .discriminatedUnion('code', [
      z
        .strictObject({
          code: z.literal('resolution_ambiguous'),
          message: NonEmptyString,
          retryable: z.literal(false),
          /** Ranked best-first; the disambiguation UI numbers these for spoken ordinals. */
          candidateElementKeys: z.array(ElementKey).min(2),
          tier: Tier,
        })
        .meta({
          title: 'ErrorResolutionAmbiguous',
          description: 'No candidate cleared the threshold. The tester must disambiguate.',
        }),
      z
        .strictObject({
          code: z.literal('resolution_not_found'),
          message: NonEmptyString,
          retryable: z.literal(false),
          targetPhrase: RedactedText,
          tier: Tier,
        })
        .meta({
          title: 'ErrorResolutionNotFound',
          description: 'Nothing in the scoped candidate set matched the phrase.',
        }),
      z
        .strictObject({
          code: z.literal('resolution_timeout'),
          message: NonEmptyString,
          retryable: z.literal(true),
          tier: Tier,
          budgetMs: LatencyMs,
          elapsedMs: LatencyMs,
        })
        .meta({
          title: 'ErrorResolutionTimeout',
          description:
            'A tier exceeded its latency budget; the caller falls back rather than waits.',
        }),
      z
        .strictObject({
          code: z.literal('memory_version_mismatch'),
          message: NonEmptyString,
          retryable: z.literal(true),
          expectedVersion: z.int().min(1),
          actualVersion: z.int().min(1),
        })
        .meta({
          title: 'ErrorMemoryVersionMismatch',
          description:
            'The held snapshot is stale. Refetch out of band; do not block the hot path.',
        }),
      z
        .strictObject({
          code: z.literal('memory_snapshot_unavailable'),
          message: NonEmptyString,
          retryable: z.literal(true),
          applicationId: Uuid,
        })
        .meta({
          title: 'ErrorMemorySnapshotUnavailable',
          description: 'No active memory version exists for the application yet.',
        }),
      z
        .strictObject({
          code: z.literal('action_confirmation_required'),
          message: NonEmptyString,
          retryable: z.literal(false),
          actionClass: ActionClass,
        })
        .meta({
          title: 'ErrorActionConfirmationRequired',
          description:
            'A class C or S action was dispatched without approval. Enforced, never bypassed.',
        }),
      z
        .strictObject({
          code: z.literal('action_target_stale'),
          message: NonEmptyString,
          retryable: z.literal(true),
          expectedStateFingerprint: StateFingerprint,
          observedStateFingerprint: StateFingerprint,
        })
        .meta({
          title: 'ErrorActionTargetStale',
          description: 'The page changed between resolution and dispatch. Re-resolve, never guess.',
        }),
      z
        .strictObject({
          code: z.literal('action_dispatch_failed'),
          message: NonEmptyString,
          retryable: z.literal(true),
          elementKey: ElementKey,
        })
        .meta({
          title: 'ErrorActionDispatchFailed',
          description: 'The executor could not deliver the event to the target element.',
        }),
      z
        .strictObject({
          code: z.literal('constraint_unsatisfiable'),
          message: NonEmptyString,
          retryable: z.literal(false),
          entity: NonEmptyString,
          /** Exactly the two constraints that collide. Never a silently dropped constraint. */
          conflicting: z.tuple([Constraint, Constraint]),
        })
        .meta({
          title: 'ErrorConstraintUnsatisfiable',
          description: 'Two constraints cannot both hold. Both are named; neither is dropped.',
        }),
      z
        .strictObject({
          code: z.literal('schema_confidence_too_low'),
          message: NonEmptyString,
          retryable: z.literal(false),
          entity: NonEmptyString,
          confidence: Confidence,
          threshold: Confidence,
          /** The specific fields that are missing or unknown. The offer to index follows. */
          missingFields: z.array(NonEmptyString),
        })
        .meta({
          title: 'ErrorSchemaConfidenceTooLow',
          description: 'Too little is known about the entity to compose. Refuse and name the gap.',
        }),
      z
        .strictObject({
          code: z.literal('reference_target_missing'),
          message: NonEmptyString,
          retryable: z.literal(false),
          entity: NonEmptyString,
          field: NonEmptyString,
          phrase: NonEmptyString,
        })
        .meta({
          title: 'ErrorReferenceTargetMissing',
          description: 'No existing record matches the referenced phrase.',
        }),
      z
        .strictObject({
          code: z.literal('uniqueness_exhausted'),
          message: NonEmptyString,
          retryable: z.literal(true),
          entity: NonEmptyString,
          field: NonEmptyString,
          attempts: z.int().min(1),
        })
        .meta({
          title: 'ErrorUniquenessExhausted',
          description: 'Bounded resampling could not find a value that does not already exist.',
        }),
      z
        .strictObject({
          code: z.literal('materializer_unavailable'),
          message: NonEmptyString,
          retryable: z.literal(false),
          entity: NonEmptyString,
          triedAdapters: z.array(MaterializerKind),
        })
        .meta({
          title: 'ErrorMaterializerUnavailable',
          description: 'No adapter in the chain could handle the plan.',
        }),
      z
        .strictObject({
          code: z.literal('materialization_failed'),
          message: NonEmptyString,
          retryable: z.literal(true),
          planId: Uuid,
          adapter: MaterializerKind,
        })
        .meta({
          title: 'ErrorMaterializationFailed',
          description: 'Every rung of the fallback chain failed; the reasons are in the result.',
        }),
      z
        .strictObject({
          code: z.literal('seeding_forbidden'),
          message: NonEmptyString,
          retryable: z.literal(false),
          applicationId: Uuid,
          environment: NonEmptyString,
        })
        .meta({
          title: 'ErrorSeedingForbidden',
          description:
            'Environment policy blocks seeding. Production is off unless auditably enabled.',
        }),
      z
        .strictObject({
          code: z.literal('drift_approval_required'),
          message: NonEmptyString,
          retryable: z.literal(false),
          driftReportId: Uuid,
        })
        .meta({
          title: 'ErrorDriftApprovalRequired',
          description: 'The memory change is pending human review. There is no auto-approve path.',
        }),
      z
        .strictObject({
          code: z.literal('unauthorized'),
          message: NonEmptyString,
          retryable: z.literal(false),
        })
        .meta({
          title: 'ErrorUnauthorized',
          description: 'No valid credential was presented.',
        }),
      z
        .strictObject({
          code: z.literal('forbidden'),
          message: NonEmptyString,
          retryable: z.literal(false),
          requiredRole: z.enum(['owner', 'lead', 'tester', 'viewer']),
        })
        .meta({
          title: 'ErrorForbidden',
          description: 'The caller is authenticated but lacks the role this action requires.',
        }),
      z
        .strictObject({
          code: z.literal('rate_limited'),
          message: NonEmptyString,
          retryable: z.literal(true),
          retryAfterSeconds: z.int().min(0),
        })
        .meta({
          title: 'ErrorRateLimited',
          description: "The tenant's rate limit was exceeded.",
        }),
      z
        .strictObject({
          code: z.literal('validation_failed'),
          message: NonEmptyString,
          retryable: z.literal(false),
          issues: z.array(ValidationIssue).min(1),
        })
        .meta({
          title: 'ErrorValidationFailed',
          description: 'A payload did not satisfy its protocol schema.',
        }),
      z
        .strictObject({
          code: z.literal('internal'),
          message: NonEmptyString,
          retryable: z.literal(true),
          /** The only thing a tester should ever be asked to quote back to support. */
          traceId: NonEmptyString,
        })
        .meta({
          title: 'ErrorInternal',
          description: 'An unexpected failure. Correlated by trace id; details stay in the logs.',
        }),
    ])
    .describe('Every failure that can cross a process boundary, discriminated on `code`.'),
);
export type WisprError = z.infer<typeof WisprError>;

/**
 * The success/failure envelope used wherever a failure is an expected outcome rather than an
 * exception — resolution below threshold, an unsatisfiable constraint set, a blocked seed.
 *
 * Generic, and therefore not part of the JSON Schema bundle: JSON Schema has no type
 * parameters. Python callers receive the concrete model on success and a `WisprError` on
 * failure, and `apps/composer` raises rather than returning an envelope. Use
 * {@link resultOf} to build the schema for a concrete payload type.
 */
export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: WisprError };

/**
 * Build the schema for `Result<T>` given the schema for `T`.
 *
 * ```ts
 * const PlanResult = resultOf(CompositionPlan);
 * const parsed: Result<CompositionPlan> = PlanResult.parse(payload);
 * ```
 */
export function resultOf<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), value }),
    z.strictObject({ ok: z.literal(false), error: WisprError }),
  ]);
}
