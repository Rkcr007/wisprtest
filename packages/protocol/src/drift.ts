import { z } from 'zod';

import {
  Confidence,
  ElementKey,
  IsoDateTime,
  NonEmptyString,
  RedactedText,
  RoutePattern,
  Sha256Hex,
  StateFingerprint,
  StructuralHash,
  Uuid,
} from './primitives.js';
import { contract } from './registry.js';

/**
 * Drift — the learning loop.
 *
 * The extension compares the live structural hash against memory on every route settle. A
 * mismatch never blocks the tester: it raises a report, shows a non-blocking notice, and the
 * session continues in degraded mode.
 *
 * A drift report is a *proposal*. Fully automatic self-healing is what destroyed trust in the
 * previous generation of QA tools — it made tests pass that should have failed. WisprTest
 * proposes; a human commits.
 */

/** An element present in the live page but absent from memory. */
export const ElementAddition = contract(
  'ElementAddition',
  z
    .strictObject({
      elementKey: ElementKey,
      role: NonEmptyString,
      accessibleNameRedacted: RedactedText,
      landmarkPath: z.array(NonEmptyString),
    })
    .describe('An element that appeared since the memory version was indexed.'),
);
export type ElementAddition = z.infer<typeof ElementAddition>;

/** An element in memory that no longer resolves in the live page. */
export const ElementRemoval = contract(
  'ElementRemoval',
  z
    .strictObject({
      elementKey: ElementKey,
      elementId: Uuid,
      role: NonEmptyString,
    })
    .describe('An element in memory that no longer exists in the live page.'),
);
export type ElementRemoval = z.infer<typeof ElementRemoval>;

/**
 * An element that still resolves but under a different ancestry. Aliases usually survive a
 * move, which is why it is tracked separately from an add plus a remove.
 */
export const ElementMove = contract(
  'ElementMove',
  z
    .strictObject({
      elementKey: ElementKey,
      elementId: Uuid,
      fromLandmarkPath: z.array(NonEmptyString),
      toLandmarkPath: z.array(NonEmptyString),
      /** Score of the moved element against its stored fingerprint. Gates alias migration. */
      matchConfidence: Confidence,
    })
    .describe('An element that survived but changed position in the landmark tree.'),
);
export type ElementMove = z.infer<typeof ElementMove>;

/**
 * An element whose accessible name changed. Only hashes and redacted forms cross this
 * boundary — a rename must never carry the raw before-and-after text.
 */
export const ElementRename = contract(
  'ElementRename',
  z
    .strictObject({
      elementKey: ElementKey,
      elementId: Uuid,
      fromNameHash: Sha256Hex,
      toNameHash: Sha256Hex,
      toNameRedacted: RedactedText,
      matchConfidence: Confidence,
    })
    .describe('An element whose accessible name changed between versions.'),
);
export type ElementRename = z.infer<typeof ElementRename>;

/**
 * A change to learned data knowledge found by re-running the schema observers over the changed
 * region — a new required field, a widened enum, a materializer that no longer verifies.
 */
export const SchemaChange = contract(
  'SchemaChange',
  z
    .strictObject({
      entity: NonEmptyString,
      kind: z.enum([
        'field_added',
        'field_removed',
        'field_type_changed',
        'required_changed',
        'enum_values_changed',
        'materializer_invalidated',
      ]),
      /** The field or materializer affected. Null for entity-level changes. */
      field: NonEmptyString.nullable(),
      /** Plain-language summary for the approval screen. */
      detail: NonEmptyString,
    })
    .describe('A change to a learned entity schema detected during reconciliation.'),
);
export type SchemaChange = z.infer<typeof SchemaChange>;

/**
 * What actually changed on a screen.
 *
 * Produced by the indexer after re-crawling only the changed region — never the whole app.
 * This is the diff a QA lead reads before approving a memory version increment.
 */
export const StructuralDiff = contract(
  'StructuralDiff',
  z
    .strictObject({
      added: z.array(ElementAddition),
      removed: z.array(ElementRemoval),
      moved: z.array(ElementMove),
      renamed: z.array(ElementRename),
      schemaChanges: z.array(SchemaChange),
    })
    .describe('The reviewable difference between memory and the live application.'),
);
export type StructuralDiff = z.infer<typeof StructuralDiff>;

/** Where a drift report came from: live detection in the extension, or a scheduled re-crawl. */
export const DriftDetector = contract(
  'DriftDetector',
  z.enum(['extension', 'indexer']).describe('Which component observed the structural mismatch.'),
);
export type DriftDetector = z.infer<typeof DriftDetector>;

/**
 * Lifecycle of a drift report.
 *
 * `open` → `reconciling` when the indexer picks it up → `diffed` once a `StructuralDiff` is
 * attached → `approved` or `rejected` by a human. There is no path that reaches `approved`
 * without a human, and none is to be added, even behind a flag.
 */
export const DriftStatus = contract(
  'DriftStatus',
  z
    .enum(['open', 'reconciling', 'diffed', 'approved', 'rejected'])
    .describe('Lifecycle state of a drift report.'),
);
export type DriftStatus = z.infer<typeof DriftStatus>;

/**
 * A proposal to change memory, raised by a structural hash mismatch.
 *
 * `aliasMigrationRate` is the fraction of this screen's aliases whose target still scored above
 * threshold after the change. A low rate means the tester's learned vocabulary is about to be
 * lost, and it is the number the approval screen leads with.
 */
export const DriftReport = contract(
  'DriftReport',
  z
    .strictObject({
      id: Uuid,
      tenantId: Uuid,
      memoryVersionId: Uuid,
      screenId: Uuid,
      routePattern: RoutePattern,
      stateFingerprint: StateFingerprint,
      expectedStructuralHash: StructuralHash,
      observedStructuralHash: StructuralHash,
      /** Null until the indexer has reconciled the changed region. */
      diff: StructuralDiff.nullable(),
      status: DriftStatus,
      detectedBy: DriftDetector,
      /** Null until a diff exists to compute it from. */
      aliasMigrationRate: Confidence.nullable(),
      /** The human who approved or rejected. Null while pending — always. */
      approvedBy: Uuid.nullable(),
      createdAt: IsoDateTime,
      resolvedAt: IsoDateTime.nullable(),
    })
    .describe('A proposed memory change raised by a structural mismatch, pending human review.'),
);
export type DriftReport = z.infer<typeof DriftReport>;
