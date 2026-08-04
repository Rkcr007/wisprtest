import type {
  CompositionNode,
  MaterializationResult,
  ProvenanceEntry,
  RuntimeState,
  SeedLedgerEntry,
  SeedNodePreview,
  SeedPlanResponse,
  SeedRevertOutcome,
} from 'protocol';

import { createStore, type Observable } from '../runtime/observable.js';

/**
 * The seeding flow — action class **S**, as a state machine.
 *
 * docs/TEST-DATA-ENGINE.md § 6 is the specification, and it is five steps: compose the plan (no
 * writes), render the preview, wait for explicit approval, materialize, show the created record.
 * This controller is steps 1 through 4. CLAUDE.md § "Reversibility taxonomy" gives class S the same
 * "**Never**" for speculative execution that class C gets, and the same requirement for
 * confirmation — with one addition that is specific to seeding: the confirmation happens against a
 * *preview*, so the tester approves values they have actually read.
 *
 * ## Approval cannot be forged, structurally
 *
 * The only method that writes is {@link SeedController.approve}, and it takes no arguments. It can
 * only send back a `planId` this controller is holding from a `plan()` call it made itself — there
 * is no entry point that accepts a plan, a record, or an id from anywhere else. That mirrors what
 * the gateway does one layer up: `packages/protocol/src/seeding.ts` notes that
 * `SeedExecuteRequest` "carries no plan — just the id of one the gateway composed and is holding",
 * so "the bytes that were previewed are the bytes that get materialized". The same property has to
 * hold on this side or the extension becomes the weak link: a HUD that could describe a record and
 * approve it in one step would let a bug create something no tester ever saw.
 *
 * The held plan is **released on the first approval**. One approval is one materialization; a
 * double-clicked approve button, or a second `approve()` racing the first, finds nothing to send.
 *
 * ## Expiry forces a re-plan rather than a stale write
 *
 * A plan is composed against one memory version and one moment. `SeedPlanResponse.expiresAt` says
 * when the gateway stops holding it, and approving after that must "re-plan against fresh memory".
 * This side checks its own clock first, so a lapsed plan is refused here with something the tester
 * can act on instead of producing a `plan_expired` from the network a second later.
 *
 * ## Nothing here is driven by a partial hypothesis
 *
 * There is no `onPartial`. The controller's only speech-facing entry point is {@link plan}, which
 * the content script calls on a **final** transcript alone. A method that does not exist cannot be
 * called by a future refactor that forgets why — which is the same reasoning that keeps seeding out
 * of {@link ActionVerb} entirely (see `seed/intent.ts`).
 *
 * ## Why no `SessionStep` is emitted
 *
 * `SessionStep` requires an `intent: ScopedQuery` and a `resolution: ResolutionResult` — it
 * describes an action aimed at *an element*, and its `verb` is an `ActionVerb`. Seeding names no
 * element and has no verb, and inventing one to fit the shape would put a fabricated resolution
 * into a tenant's timeline. The audit record for seeding is the one the design already gives it:
 * the `SeedLedgerEntry` per created record (§ 5), plus the `audit_log` rows the gateway writes for
 * every plan, execute and revert attempt including the refusals. That trail is complete without
 * this controller writing a verb-shaped row about a verbless action.
 */

/** One field of a previewed record, paired with the reason it holds the value it does. */
export interface SeedFieldView {
  readonly field: string;
  readonly value: unknown;
  readonly source: ProvenanceEntry['source'];
  /** Human-readable and specific: "matched from 64 known accounts". Rendered verbatim. */
  readonly explanation: string;
  readonly confidence: number;
}

/**
 * One record the tester is being asked to approve.
 *
 * The composer's node (what the record *is*) and the gateway's preview (how it will be *written*)
 * are joined here by `nodeId`, because the card has to show both together: a value without its
 * adapter tells a tester what will exist but not what the test covered, and § 4 is explicit that
 * "the chosen adapter... [is] shown in the HUD".
 */
export interface SeedNodeView {
  readonly nodeId: string;
  readonly entity: string;
  readonly mode: CompositionNode['mode'];
  /** Null exactly when the node is reused — nothing is created, so no adapter runs. */
  readonly adapter: SeedNodePreview['adapter'];
  readonly adapterReason: string;
  readonly revertible: boolean;
  /** Plain language, rendered verbatim: "no delete path was indexed for Order". */
  readonly revertDetail: string;
  readonly fields: readonly SeedFieldView[];
}

/**
 * Where the flow is.
 *
 * `previewing` is the only state from which anything can be written, and it is reached only by a
 * composer answer that produced a plan. A conflict or a refusal lands in `answered` — they are
 * answers the tester needs to read, not failures, and there is nothing to approve in either.
 */
export type SeedPhase =
  | 'idle'
  | 'planning'
  | 'previewing'
  | 'answered'
  | 'executing'
  | 'executed'
  | 'reverting'
  | 'failed';

export interface SeedView {
  readonly phase: SeedPhase;
  /** The redacted utterance being composed, for the card's header. Null when idle. */
  readonly utterance: string | null;
  /** The records awaiting approval, in materialization order. Empty unless `previewing`. */
  readonly nodes: readonly SeedNodeView[];
  /**
   * What the composer concluded, in plain language, when it did not produce a plan.
   *
   * A conflict's `explanation` ("over £50,000 and under £1,000 cannot both hold") or a refusal's
   * `reason` plus the fields it could not fill. Null while a plan is in hand.
   */
  readonly answer: string | null;
  /** What materialization did, once it has run. Carries every rung of the chain, failures included. */
  readonly result: MaterializationResult | null;
  /** One per created record. What the marker decorates and what a revert acts on. */
  readonly ledger: readonly SeedLedgerEntry[];
  /** Outcomes of the last revert, entry by entry. Empty until one has run. */
  readonly reverted: readonly SeedRevertOutcome[];
  /** Concrete failure text for the `failed` phase. Null otherwise. */
  readonly error: string | null;
}

export const IDLE_SEED_VIEW: SeedView = {
  phase: 'idle',
  utterance: null,
  nodes: [],
  answer: null,
  result: null,
  ledger: [],
  reverted: [],
  error: null,
};

/**
 * Why a seed call produced no answer.
 *
 * Separated from the composer's own answers on purpose: a conflict and a refusal are things the
 * system *concluded* and are shown as such, while these are things that went wrong on the way.
 * `forbidden` is called out because it is the one a tester can neither retry nor fix — production
 * seeding is off for this application, and that is a policy decision, not an outage.
 */
export type SeedFailureReason = 'unavailable' | 'timeout' | 'forbidden' | 'invalid' | 'failed';

export type SeedPlanOutcome =
  | { readonly ok: true; readonly response: SeedPlanResponse }
  | { readonly ok: false; readonly reason: SeedFailureReason; readonly detail: string | null };

export type SeedExecuteOutcome =
  | {
      readonly ok: true;
      readonly result: MaterializationResult;
      readonly ledger: readonly SeedLedgerEntry[];
    }
  | { readonly ok: false; readonly reason: SeedFailureReason; readonly detail: string | null };

export type SeedRevertResult =
  | { readonly ok: true; readonly outcomes: readonly SeedRevertOutcome[] }
  | { readonly ok: false; readonly reason: SeedFailureReason; readonly detail: string | null };

/**
 * The gateway, as this controller needs it.
 *
 * Every method resolves rather than rejects. The transport lives in the service worker — it is the
 * only side that holds the scoped token — and a port is not a call, so a failure there arrives as
 * an outcome. Nothing on this path may throw into the HUD.
 */
export interface SeedTransport {
  plan(input: {
    readonly utterance: string;
    readonly runtimeState: RuntimeState;
  }): Promise<SeedPlanOutcome>;
  execute(input: {
    readonly planId: string;
    readonly approvedAt: string;
  }): Promise<SeedExecuteOutcome>;
  revert(
    input:
      { readonly scope: 'entry'; readonly ledgerEntryId: string } | { readonly scope: 'session' },
  ): Promise<SeedRevertResult>;
}

export interface SeedControllerOptions {
  readonly transport: SeedTransport;
  /** Wall clock, injected so expiry is testable without waiting. */
  readonly wallClock?: () => Date;
  readonly onError?: (error: unknown) => void;
}

export interface SeedController {
  readonly view: Observable<SeedView>;
  /**
   * Compose a plan for one utterance. Writes nothing — `/v1/seed/plan` is a read.
   *
   * Called on a **final** transcript only. There is deliberately no partial-hypothesis entry point.
   */
  plan(utterance: string, runtimeState: RuntimeState): Promise<void>;
  /**
   * The tester's explicit yes. The only method that writes to the application under test.
   *
   * A no-op unless a plan composed by this controller is being previewed and has not lapsed.
   */
  approve(): Promise<void>;
  /** Dismiss the card without approving. The held plan is dropped and expires server-side. */
  dismiss(): void;
  /** Undo one seeded record. */
  revertEntry(ledgerEntryId: string): Promise<void>;
  /** Undo everything this session seeded, in reverse dependency order. */
  revertSession(): Promise<void>;
  dispose(): void;
}

/** A plan this controller composed and is holding, and the only thing `approve` can send. */
interface HeldPlan {
  readonly planId: string;
  /** Epoch milliseconds. Compared against this side's clock before approval is sent. */
  readonly expiresAtMs: number;
}

/** Join the composer's nodes to the gateway's previews, in materialization order. */
export function buildNodeViews(response: SeedPlanResponse): readonly SeedNodeView[] {
  const outcome = response.composition.outcome;
  if (outcome.kind !== 'planned') return [];

  const nodeById = new Map<string, CompositionNode>();
  for (const node of outcome.plan.nodes) nodeById.set(node.nodeId, node);

  const previewById = new Map<string, SeedNodePreview>();
  for (const preview of response.preview) previewById.set(preview.nodeId, preview);

  const views: SeedNodeView[] = [];
  // The gateway's order, not the composer's: `preview` is documented as "one entry per plan node,
  // in materialization order", which is the order the records will actually appear in the app.
  for (const preview of response.preview) {
    const node = nodeById.get(preview.nodeId);
    if (node === undefined) continue;

    // Provenance is the field list. § 3 makes an explanation per field non-negotiable — "this is
    // what the preview card renders, and it is what makes the feature trustworthy rather than
    // spooky" — so a field the composer did not explain is not shown as an unexplained value.
    const fields: SeedFieldView[] = node.provenance.map((entry) => ({
      field: entry.field,
      value: entry.value,
      source: entry.source,
      explanation: entry.explanation,
      confidence: entry.confidence,
    }));

    views.push({
      nodeId: preview.nodeId,
      entity: preview.entity,
      mode: node.mode,
      adapter: preview.adapter,
      adapterReason: preview.adapterReason,
      revertible: preview.revert.revertible,
      revertDetail: preview.revert.detail,
      fields,
    });
  }

  // Any node the gateway did not preview is still a record that would be written. Rather than hide
  // it, append it with the fact that the gateway said nothing about how it will be written.
  for (const node of outcome.plan.nodes) {
    if (previewById.has(node.nodeId)) continue;
    views.push({
      nodeId: node.nodeId,
      entity: node.entity,
      mode: node.mode,
      adapter: null,
      adapterReason: 'the gateway did not say which adapter will run for this record',
      revertible: false,
      revertDetail: 'the gateway did not say whether this record can be removed',
      fields: node.provenance.map((entry) => ({
        field: entry.field,
        value: entry.value,
        source: entry.source,
        explanation: entry.explanation,
        confidence: entry.confidence,
      })),
    });
  }

  return views;
}

/** The composer's non-plan answers, phrased for the card. */
function answerText(response: SeedPlanResponse): string | null {
  const outcome = response.composition.outcome;
  if (outcome.kind === 'conflict') return outcome.conflict.explanation;
  if (outcome.kind === 'refused') {
    const fields = outcome.missingFields.join(', ');
    return fields === ''
      ? outcome.reason
      : `${outcome.reason} — the schema does not describe: ${fields}`;
  }
  return null;
}

/** Phrase a transport failure so a tester knows whether to retry, wait, or ask someone. */
function failureText(reason: SeedFailureReason, detail: string | null): string {
  const base =
    reason === 'forbidden'
      ? 'seeding is not enabled for this application'
      : reason === 'timeout'
        ? 'the gateway did not answer in time'
        : reason === 'unavailable'
          ? 'the gateway could not be reached'
          : reason === 'invalid'
            ? 'the gateway rejected the request'
            : 'seeding failed';
  return detail === null || detail === '' ? base : `${base}: ${detail}`;
}

export function createSeedController(options: SeedControllerOptions): SeedController {
  const { transport } = options;
  const wallClock = options.wallClock ?? (() => new Date());

  const store = createStore<SeedView>(IDLE_SEED_VIEW);

  /**
   * The plan awaiting approval.
   *
   * Held here rather than on the view because the view is what the HUD renders and the HUD has no
   * business being able to hand an id back. `approve()` reads this and nothing else.
   */
  let held: HeldPlan | null = null;

  /**
   * Monotonic, and incremented on every request the controller starts.
   *
   * Speech is faster than the network: a tester can say a second precondition while the first is
   * still composing. Without this, the first response would land after the second and overwrite a
   * newer preview with a stale one — and the tester would approve a card that does not describe the
   * plan the gateway is holding.
   */
  let generation = 0;

  function publish(view: SeedView): void {
    store.set(view);
  }

  function current(): SeedView {
    return store.observable.value;
  }

  return {
    view: store.observable,

    async plan(utterance, runtimeState): Promise<void> {
      const mine = ++generation;
      // A new request abandons any plan still on screen. The gateway keeps holding it until its
      // expiry, unapproved, which is the correct outcome for a preview the tester talked over.
      held = null;
      publish({ ...IDLE_SEED_VIEW, phase: 'planning', utterance });

      let outcome: SeedPlanOutcome;
      try {
        outcome = await transport.plan({ utterance, runtimeState });
      } catch (error: unknown) {
        options.onError?.(error);
        outcome = { ok: false, reason: 'failed', detail: null };
      }
      if (mine !== generation) return;

      if (!outcome.ok) {
        publish({
          ...IDLE_SEED_VIEW,
          phase: 'failed',
          utterance,
          error: failureText(outcome.reason, outcome.detail),
        });
        return;
      }

      const response = outcome.response;
      const answer = answerText(response);
      if (response.planId === null || response.expiresAt === null) {
        // A conflict or a refusal. Both are answers, and both leave nothing to approve — which the
        // contract enforces: "a planned outcome is held under an id; a conflict or refusal holds
        // nothing".
        publish({
          ...IDLE_SEED_VIEW,
          phase: 'answered',
          utterance,
          answer: answer ?? 'the composer produced no plan',
        });
        return;
      }

      held = { planId: response.planId, expiresAtMs: Date.parse(response.expiresAt) };
      publish({
        ...IDLE_SEED_VIEW,
        phase: 'previewing',
        utterance,
        nodes: buildNodeViews(response),
      });
    },

    async approve(): Promise<void> {
      const plan = held;
      // Nothing to approve. Not an error: a stray confirmation with no card on screen is exactly
      // what should do nothing at all.
      if (plan === null) return;
      if (current().phase !== 'previewing') return;

      const approvedAt = wallClock();
      if (Number.isFinite(plan.expiresAtMs) && approvedAt.getTime() > plan.expiresAtMs) {
        held = null;
        publish({
          ...current(),
          phase: 'failed',
          nodes: [],
          error: 'this plan has expired — say it again to compose a fresh one',
        });
        return;
      }

      // Released before the call, not after. One approval is one materialization: a second
      // `approve()` racing this one finds nothing held and cannot turn one yes into two records.
      held = null;
      const previewing = current();
      publish({ ...previewing, phase: 'executing' });

      let outcome: SeedExecuteOutcome;
      try {
        outcome = await transport.execute({
          planId: plan.planId,
          approvedAt: approvedAt.toISOString(),
        });
      } catch (error: unknown) {
        options.onError?.(error);
        outcome = { ok: false, reason: 'failed', detail: null };
      }

      if (!outcome.ok) {
        publish({
          ...previewing,
          phase: 'failed',
          error: failureText(outcome.reason, outcome.detail),
        });
        return;
      }

      // A failed materialization comes back as a result, not an error: the attempts are the answer.
      // § 4 forbids silent degradation, so the whole chain is kept and the card renders every rung.
      const created = outcome.result.outcome === 'created';
      publish({
        ...previewing,
        phase: created ? 'executed' : 'failed',
        result: outcome.result,
        ledger: outcome.ledger,
        error: created ? null : outcome.result.failureReason,
      });
    },

    dismiss(): void {
      held = null;
      generation += 1;
      publish(IDLE_SEED_VIEW);
    },

    async revertEntry(ledgerEntryId): Promise<void> {
      await runRevert({ scope: 'entry', ledgerEntryId });
    },

    async revertSession(): Promise<void> {
      await runRevert({ scope: 'session' });
    },

    dispose(): void {
      held = null;
      store.close();
    },
  };

  async function runRevert(
    input: { scope: 'entry'; ledgerEntryId: string } | { scope: 'session' },
  ): Promise<void> {
    const before = current();
    publish({ ...before, phase: 'reverting' });

    let outcome: SeedRevertResult;
    try {
      outcome = await transport.revert(input);
    } catch (error: unknown) {
      options.onError?.(error);
      outcome = { ok: false, reason: 'failed', detail: null };
    }

    if (!outcome.ok) {
      publish({ ...before, phase: 'failed', error: failureText(outcome.reason, outcome.detail) });
      return;
    }

    // Partial success is normal and is reported as such: three of four removed, and why the fourth
    // was not. The ledger keeps only the entries that are still outstanding, so the marker stops
    // decorating what is gone.
    const removed = new Set(
      outcome.outcomes
        .filter((entry) => entry.outcome === 'reverted' || entry.outcome === 'already_reverted')
        .map((entry) => entry.ledgerEntryId),
    );
    publish({
      ...before,
      phase: 'executed',
      ledger: before.ledger.filter((entry) => !removed.has(entry.id)),
      reverted: outcome.outcomes,
      error: null,
    });
  }
}
