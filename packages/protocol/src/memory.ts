import { z } from 'zod';

import {
  Confidence,
  ElementKey,
  IsoDateTime,
  NonEmptyString,
  Ordinal,
  RedactedText,
  RoutePattern,
  Sha256Hex,
  StateFingerprint,
  StructuralHash,
  Uuid,
} from './primitives.js';
import { contract } from './registry.js';

/**
 * Product Memory — the structure of an application, learned once during indexing.
 *
 * Per CLAUDE.md § "PII rule", memory stores **structure, never content**. Accessible names are
 * persisted as a SHA-256 digest plus a redacted display form; the raw name never leaves the
 * page. A table of customer names must never end up here or in an LLM request.
 */

/**
 * Element position normalised against the viewport, so it survives a window resize and a
 * different tester's monitor. The weakest fingerprint signal (weight 0.05) and used only to
 * break ties that nothing else can.
 */
export const NormalizedBBox = contract(
  'NormalizedBBox',
  z
    .strictObject({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().min(0).max(1),
      height: z.number().min(0).max(1),
    })
    .describe('Element bounds as fractions of the viewport, in the range [0, 1].'),
);
export type NormalizedBBox = z.infer<typeof NormalizedBBox>;

/**
 * The seven fingerprint signals from docs/ARCHITECTURE.md § 2, in one record.
 *
 * | Signal                                              | Weight |
 * |-----------------------------------------------------|--------|
 * | Computed ARIA role                                  | 0.20   |
 * | Accessible name (normalised, PII-scrubbed)          | 0.25   |
 * | Landmark / section ancestry path                    | 0.15   |
 * | Stable attributes (data-testid, name, non-generated id) | 0.20 |
 * | Ordinal within parent group                         | 0.08   |
 * | Text shingle hash                                   | 0.07   |
 * | Viewport-normalised bbox                            | 0.05   |
 *
 * The weights themselves live in `packages/fingerprint` as overridable config, not here — this
 * schema is the payload, not the scoring policy.
 */
export const ElementFingerprint = contract(
  'ElementFingerprint',
  z
    .strictObject({
      /** Computed ARIA role, not the tag name. Survives restyles. */
      role: NonEmptyString.describe('Computed ARIA role of the element.'),
      /** Lowercase tag name, kept for executor dispatch decisions, not for scoring. */
      tagName: NonEmptyString.describe('Lowercase HTML tag name.'),
      /** SHA-256 of the normalised accessible name. The raw name is never transmitted. */
      accessibleNameHash: Sha256Hex.describe('SHA-256 of the normalised accessible name.'),
      /** Redacted display form of the accessible name, safe to show and to prompt with. */
      accessibleNameRedacted: RedactedText.describe('PII-scrubbed accessible name for display.'),
      /** Landmark and section ancestry, outermost first — e.g. `["main", "region:orders"]`. */
      landmarkPath: z
        .array(NonEmptyString)
        .describe('Landmark and section ancestry, outermost first.'),
      /**
       * Attributes judged stable by `packages/fingerprint` — framework-generated ids are
       * rejected before they reach this map, so its presence is near-decisive in scoring.
       */
      stableAttributes: z
        .record(z.string(), z.string())
        .describe('Attributes judged non-generated and therefore stable.'),
      /** Position within the parent group. Breaks ties inside lists and tables. */
      ordinal: Ordinal.describe('Zero-based position within the parent group.'),
      /** Hash of a shingled form of the element text. Content-derived and weakest. */
      textShingleHash: Sha256Hex.describe('SHA-256 over shingled element text.'),
      /** Viewport-normalised bounds. Last resort signal. */
      bbox: NormalizedBBox,
    })
    .describe('Weighted signals identifying one element across renders of an application.'),
);
export type ElementFingerprint = z.infer<typeof ElementFingerprint>;

/**
 * A fingerprint as stored against a screen: identity, plus how much the indexer trusts it.
 *
 * `confidence` is how sure the extractor is that the fingerprint identifies this element
 * uniquely on the screen. `stability` is how consistently it has re-resolved across memory
 * versions — a low-stability element is the first candidate for a drift report.
 */
export const ElementRecord = contract(
  'ElementRecord',
  z
    .strictObject({
      id: Uuid,
      screenId: Uuid,
      elementKey: ElementKey,
      fingerprint: ElementFingerprint,
      confidence: Confidence.describe('Indexer confidence that this fingerprint is unambiguous.'),
      stability: Confidence.describe('Re-resolution rate across previous memory versions.'),
    })
    .describe('One indexed element, stored against the screen it was found on.'),
);
export type ElementRecord = z.infer<typeof ElementRecord>;

/**
 * One reachable state of the application, keyed by `stateFingerprint`.
 *
 * A screen is not a URL. `/orders/:id` with a confirmation dialog open is a different screen
 * from `/orders/:id` without one, because a different set of elements is reachable.
 */
export const ScreenNode = contract(
  'ScreenNode',
  z
    .strictObject({
      id: Uuid,
      memoryVersionId: Uuid,
      routePattern: RoutePattern,
      stateFingerprint: StateFingerprint,
      /** Human label for the console and the HUD, e.g. "Orders list". */
      label: NonEmptyString.describe('Human-readable screen name.'),
      structuralHash: StructuralHash,
      indexedAt: IsoDateTime,
    })
    .describe('One reachable state of the application under test.'),
);
export type ScreenNode = z.infer<typeof ScreenNode>;

/**
 * A condition that must hold before a navigation edge can be taken.
 *
 * Kept to a closed set the runtime state engine can evaluate from `RuntimeState` alone,
 * without touching the DOM — an edge whose precondition needs a DOM query is not usable
 * inside the resolution budget.
 */
export const NavPrecondition = contract(
  'NavPrecondition',
  z
    .discriminatedUnion('kind', [
      z
        .strictObject({ kind: z.literal('element_visible'), elementKey: ElementKey })
        .meta({ title: 'NavPreconditionElementVisible' }),
      z
        .strictObject({ kind: z.literal('route_matches'), routePattern: RoutePattern })
        .meta({ title: 'NavPreconditionRouteMatches' }),
      z
        .strictObject({ kind: z.literal('modal_open'), modalLabel: NonEmptyString })
        .meta({ title: 'NavPreconditionModalOpen' }),
      z
        .strictObject({ kind: z.literal('no_modal_open') })
        .meta({ title: 'NavPreconditionNoModal' }),
    ])
    .describe('Condition evaluated against RuntimeState before a nav edge may be taken.'),
);
export type NavPrecondition = z.infer<typeof NavPrecondition>;

/**
 * A transition between two screens, and the element that causes it.
 *
 * Derived during indexing by observing which click produced which route change — never
 * declared. This is the graph the console renders and the runtime walks for "open orders".
 */
export const NavEdge = contract(
  'NavEdge',
  z
    .strictObject({
      id: Uuid,
      memoryVersionId: Uuid,
      fromScreenId: Uuid,
      toScreenId: Uuid,
      /** The element whose activation causes the transition. */
      triggerElementId: Uuid,
      preconditions: z.array(NavPrecondition),
      /** How often the transition was observed to succeed during indexing. */
      confidence: Confidence,
    })
    .describe('Observed transition from one screen to another via a trigger element.'),
);
export type NavEdge = z.infer<typeof NavEdge>;

/**
 * Lifecycle of a memory version.
 *
 * `building` → `active` on a successful index; `building` → `failed` with a reason on error;
 * `active` → `superseded` when a newer version is approved. A version never returns to
 * `building`; re-indexing creates a new one, so a rollback is a version pointer change.
 */
export const MemoryVersionStatus = contract(
  'MemoryVersionStatus',
  z
    .enum(['building', 'active', 'superseded', 'failed'])
    .describe('Lifecycle state of a memory version.'),
);
export type MemoryVersionStatus = z.infer<typeof MemoryVersionStatus>;

/**
 * One indexed generation of an application's memory.
 *
 * A version becomes `active` only after a human approves it — see CLAUDE.md and
 * docs/BUILD-PLAN.md Phase 17. There is no auto-approve path.
 */
export const MemoryVersion = contract(
  'MemoryVersion',
  z
    .strictObject({
      id: Uuid,
      tenantId: Uuid,
      applicationId: Uuid,
      /** Monotonic per application, starting at 1. */
      version: z.int().min(1).describe('Monotonic version number within the application.'),
      status: MemoryVersionStatus,
      createdAt: IsoDateTime,
      /** The user who approved activation. Null while building, failed, or unapproved. */
      approvedBy: Uuid.nullable(),
      /** Populated only when `status` is `failed`. */
      failureReason: NonEmptyString.nullable(),
    })
    .describe('One indexed generation of an application, and its approval state.'),
);
export type MemoryVersion = z.infer<typeof MemoryVersion>;

/** Where an alias came from. Corrections are the highest-quality signal the system gets. */
export const AliasSource = contract(
  'AliasSource',
  z
    .enum(['indexed', 't2_writeback', 'manual'])
    .describe('Provenance of an alias: derived at index time, written back from T2, or authored.'),
);
export type AliasSource = z.infer<typeof AliasSource>;

/**
 * A learned phrase → element mapping. The compounding asset.
 *
 * Scoped per tenant *and* per memory version: structural learning may be shared across
 * tenants, vocabulary may not. `stateFingerprint` narrows an alias to one screen when the
 * same phrase means different things in different places; null means it applies app-wide.
 */
export const Alias = contract(
  'Alias',
  z
    .strictObject({
      id: Uuid,
      tenantId: Uuid,
      memoryVersionId: Uuid,
      /** Normalised utterance fragment, already redacted. */
      phrase: NonEmptyString.describe('Normalised, redacted phrase as spoken by a tester.'),
      elementId: Uuid,
      stateFingerprint: StateFingerprint.nullable(),
      source: AliasSource,
      /** Times this alias produced a T0 hit. Drives pruning and the tier distribution metric. */
      hits: z.int().min(0),
      createdAt: IsoDateTime,
    })
    .describe('Learned mapping from a spoken phrase to an element, scoped per tenant.'),
);
export type Alias = z.infer<typeof Alias>;

/**
 * Everything the extension needs to resolve against an application, in one payload.
 *
 * Fetched once on attach, cached in Redis by `(tenant, app, version)`, and held in the service
 * worker for the session. The hot path never fetches this again: a version mismatch triggers a
 * refetch out of band, it does not block resolution.
 */
export const MemorySnapshot = contract(
  'MemorySnapshot',
  z
    .strictObject({
      tenantId: Uuid,
      applicationId: Uuid,
      memoryVersion: MemoryVersion,
      screens: z.array(ScreenNode),
      elements: z.array(ElementRecord),
      navEdges: z.array(NavEdge),
      aliases: z.array(Alias),
      generatedAt: IsoDateTime,
    })
    .describe('Complete resolvable memory for one application at one version.'),
);
export type MemorySnapshot = z.infer<typeof MemorySnapshot>;

/**
 * One learned phrase → element mapping the extension asks the gateway to persist.
 *
 * The write-back item, as opposed to {@link Alias} which is the stored row. It carries no `id`,
 * no `tenantId` and no `hits`: the tenant comes from the scoped token, the id and hit count are
 * the database's, and the memory version is named once on the enclosing batch. `phrase` is
 * already normalised and redacted — the raw utterance never leaves the extension, per
 * CLAUDE.md § "PII rule".
 *
 * `source` excludes `indexed`: an indexed alias is written by the crawl, not fed back from a
 * runtime resolution. The two sources that reach this endpoint are a T2 escalation that
 * succeeded and a tester's correction, and a correction is the highest-quality signal the
 * system gets.
 */
export const AliasWriteback = contract(
  'AliasWriteback',
  z
    .strictObject({
      phrase: NonEmptyString.describe('Normalised, redacted phrase as spoken by a tester.'),
      elementId: Uuid,
      stateFingerprint: StateFingerprint.nullable(),
      source: z
        .enum(['t2_writeback', 'manual'])
        .describe('Where the alias came from: a T2 resolution, or a tester correction.'),
    })
    .describe('A single phrase → element mapping to persist as an alias.'),
);
export type AliasWriteback = z.infer<typeof AliasWriteback>;

/**
 * A batch of alias write-backs for one memory version.
 *
 * Batched because the extension flushes its write-back queue rather than making a request per
 * resolution (docs/BUILD-PLAN.md Phase 11: "Flush the queue in batches every 10s and on
 * detach"). The `memoryVersionId` scopes every item: an alias learned against one version does
 * not silently migrate to the next, which is a different version's decision to make.
 */
export const AliasWritebackBatch = contract(
  'AliasWritebackBatch',
  z
    .strictObject({
      memoryVersionId: Uuid,
      items: z
        .array(AliasWriteback)
        .min(1)
        .describe('At least one write-back; an empty batch is a bug, not a no-op.'),
    })
    .describe('Alias write-backs to persist against one memory version, scoped to the tenant.'),
);
export type AliasWritebackBatch = z.infer<typeof AliasWritebackBatch>;

/**
 * What the gateway reports back after persisting a batch.
 *
 * `inserted` and `updated` sum to `accepted`. The split matters to the compounding-loop metric:
 * an `updated` means the phrase was already known and its hit count climbed, an `inserted` means
 * a genuinely new mapping was learned.
 */
export const AliasWritebackResult = contract(
  'AliasWritebackResult',
  z
    .strictObject({
      accepted: z.int().min(0).describe('Total write-backs processed.'),
      inserted: z.int().min(0).describe('Write-backs that created a new alias.'),
      updated: z
        .int()
        .min(0)
        .describe('Write-backs that matched an existing phrase and bumped it.'),
    })
    .describe('Outcome of persisting a batch of alias write-backs.'),
);
export type AliasWritebackResult = z.infer<typeof AliasWritebackResult>;
