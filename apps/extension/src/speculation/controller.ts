import { defaultRedactor, type Redactor } from 'fingerprint';
import {
  ActionRequest,
  SessionStep,
  type ActionClass,
  type ActionPayload,
  type ActionVerb,
  type ElementKey,
  type ResolutionResult,
  type ScopedQuery,
} from 'protocol';

import { createStore, type Observable } from '../runtime/observable.js';
import type { ActionExecutor, DispatchContext } from '../executor/index.js';
import { parseOrdinal, type Disambiguation } from '../resolver/index.js';
import { classifyAction, resolveClassifyConfig, type ClassifyConfig } from './classify.js';
import type { IntentParser, ParsedIntent } from './intent.js';
import type { Locator } from './locate.js';
import { captureRollback, type RollbackRecord } from './rollback.js';

/**
 * The speculation controller — the reversibility taxonomy, turned into a state machine.
 *
 * This is `onPartialHypothesis` / `onRevisedHypothesis` / `onFinalTranscript` from
 * docs/ARCHITECTURE.md § 3, and it is where CLAUDE.md § "Reversibility taxonomy" is *enforced at
 * runtime* rather than merely typed. The rule that matters most is the one the release-gate test
 * pins down: a class-C action — submit, delete, approve — is never executed from a partial speech
 * hypothesis, not even when that partial's text is identical to the final transcript. Speculating
 * on a class-C action is, in CLAUDE.md's words, "the single worst bug this product can have."
 *
 * ## The flow, per hypothesis
 *
 * ```
 * partial ─► parse ─► resolve (scoped) ─► classify(verb, confidence)
 *                                              │
 *              confidence < τ ──────────────► A: stage the reticle, never execute
 *              class ≠ R ────────────────────► C/S: stage the reticle, never execute
 *              class R ─────────────────────► execute speculatively, keep a rollback record
 *
 * revised partial that diverges ─► roll back the class-R effect
 * final (class R) ──────────────► commit (keep the speculative effect, or execute now)
 * final (class C) ──────────────► stage + 150 ms stability window + await explicit confirmation
 * confirm() after stability ────► execute
 * ```
 *
 * Rollback is captured *before* the speculative effect is applied and replayed if a higher-revision
 * hypothesis names a different target — that capture-then-maybe-undo is the entire reason class R
 * may run ahead of a finished sentence (rollback.ts).
 *
 * ## What it publishes
 *
 * A single {@link SpeculationView} observable the HUD renders: the reticle rect and phase, the verb
 * and target, the action class, and whether a committing action is waiting for the tester's yes.
 * `staged` and `executed` are truthful — a class-C reticle can reach `staged` and can only reach
 * `executed` after a real confirmation, so the colour a tester sees never lies about whether
 * anything happened.
 */

export interface SpeculationView {
  readonly phase: 'idle' | 'aiming' | 'staged' | 'executed';
  /** Viewport rect of the target, for the reticle. Null when nothing is aimed at. */
  readonly rect: { x: number; y: number; width: number; height: number } | null;
  /** Redacted label of the target. */
  readonly label: string | null;
  readonly verb: ActionVerb | null;
  readonly actionClass: ActionClass | null;
  readonly confidence: number | null;
  /** True when a class-C/S action is staged and waiting for the tester's explicit confirmation. */
  readonly awaitingConfirmation: boolean;
}

export const IDLE_VIEW: SpeculationView = {
  phase: 'idle',
  rect: null,
  label: null,
  verb: null,
  actionClass: null,
  confidence: null,
  awaitingConfirmation: false,
};

export interface Hypothesis {
  readonly revision: number;
  readonly transcript: string;
}

export interface ControllerSource {
  current(): { readonly stateFingerprint: string; readonly candidates: readonly Element[] };
}

export interface ResolverLike {
  resolve(phrase: string): Promise<ResolutionResult>;
  /**
   * The numbered choice the resolver is asking the tester to make, if any.
   *
   * Optional, so a caller that only wants resolution — a benchmark, an older test — need not
   * implement disambiguation at all. Without it the controller simply never answers ordinals.
   */
  pending?(): Disambiguation | null;
  /** Answer the open choice by one-based ordinal. Records the correction as an alias. */
  choose?(ordinal: number): ResolutionResult | null;
  /** Abandon the open choice without answering it. */
  clearPending?(): void;
}

export interface SpeculationControllerOptions {
  readonly parser: IntentParser;
  readonly resolver: ResolverLike;
  readonly executor: ActionExecutor;
  readonly locator: Locator;
  readonly source: ControllerSource;
  /** The session these steps belong to. Phase 12 supplies a real one; a stub id serves until then. */
  readonly sessionId?: string;
  readonly window?: Window;
  readonly classifyConfig?: Partial<ClassifyConfig>;
  /**
   * Whether the screen the tester is on has drifted from memory.
   *
   * A predicate rather than a value, because drift is discovered mid-session: the engine settles on
   * a new route, the detector finds a mismatch, and every classification from that moment on has to
   * account for it. Read at classification time so a controller built before the drift was noticed
   * still degrades correctly. Defaults to "not drifted".
   */
  readonly screenDrifted?: () => boolean;
  readonly redact?: Redactor;
  readonly now?: () => number;
  readonly wallClock?: () => Date;
  readonly idGen?: () => string;
  /** The class-C stability window, per the phase spec. */
  readonly stabilityWindowMs?: number;
  /** Schedule a callback after `ms`, returning a cancel handle. Injected for deterministic tests. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  /** Destination path for a navigation trigger, from the nav graph. Null falls back to the current path. */
  readonly navRouteFor?: (elementId: string) => string | null;
  /** Where every emitted step goes — the executor's and the controller's alike. */
  readonly onStep?: (step: SessionStep) => void;
  readonly onError?: (error: unknown) => void;
}

export interface SpeculationController {
  readonly view: Observable<SpeculationView>;
  /** A new utterance is beginning: reset, undoing any uncommitted speculative effect. */
  onSpeechOnset(): void;
  onPartial(hypothesis: Hypothesis): Promise<void>;
  onFinal(hypothesis: Hypothesis): Promise<void>;
  /** The tester's explicit yes for a staged class-C action. */
  confirm(): void;
  /** Abandon the current utterance, rolling back and recording a staged commit that never ran. */
  cancel(): void;
  dispose(): void;
}

/** A synthetic target for the window-level verbs (scroll, back), which name no memory element. */
const VIEWPORT_KEY = 'viewport.window.root' as ElementKey;
const VIEWPORT_ID = '00000000-0000-4000-8000-ffffffffffff';

const SCROLL_DIRECTIONS = new Set(['up', 'down', 'top', 'bottom']);

interface PendingCommit {
  readonly resolved: Extract<ResolutionResult, { outcome: 'resolved' }>;
  readonly element: Element;
  readonly parse: ParsedIntent;
  readonly resolution: ResolutionResult;
  readonly utterance: string;
  readonly scopedQuery: ScopedQuery;
  readonly actionClass: ActionClass;
  executed: boolean;
}

interface Utterance {
  onsetAt: number;
  revision: number;
  /** The target of the currently-live speculative class-R effect, if any. */
  executedKey: ElementKey | null;
  rollback: RollbackRecord | null;
  final: boolean;
  pendingC: PendingCommit | null;
  stable: boolean;
  confirmedByUser: boolean;
  cancelStability: (() => void) | null;
}

function defaultNow(): number {
  return typeof performance === 'object' ? performance.now() : Date.now();
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  return () => {
    clearTimeout(handle);
  };
}

export function createSpeculationController(
  options: SpeculationControllerOptions,
): SpeculationController {
  const win = options.window ?? window;
  const redact = options.redact ?? defaultRedactor;
  const now = options.now ?? defaultNow;
  const wallClock = options.wallClock ?? (() => new Date());
  const newId = options.idGen ?? (() => crypto.randomUUID());
  const classifyConfig = resolveClassifyConfig(options.classifyConfig);
  const stabilityWindowMs = options.stabilityWindowMs ?? 150;
  const schedule = options.schedule ?? defaultSchedule;
  const sessionId = options.sessionId ?? '00000000-0000-4000-8000-000000000000';

  const store = createStore<SpeculationView>(IDLE_VIEW);
  let ordinal = 0;
  const nextOrdinal = (): number => ordinal++;

  function fresh(onsetAt: number): Utterance {
    return {
      onsetAt,
      revision: -1,
      executedKey: null,
      rollback: null,
      final: false,
      pendingC: null,
      stable: false,
      confirmedByUser: false,
      cancelStability: null,
    };
  }

  let current: Utterance = fresh(now());

  /**
   * The intent behind a question the tester has not answered yet.
   *
   * It lives outside `current` on purpose: the tester releases the talk key after the ambiguous
   * command and presses it again to say "two", and that second press resets `current`. What must
   * survive between the two is *what they were trying to do* — the verb, the constraints, the value
   * they were typing — because the ordinal itself carries none of it.
   */
  let asked: { readonly parse: ParsedIntent; readonly utterance: string } | null = null;

  function rectOf(element: Element): SpeculationView['rect'] {
    const r = element.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  function publish(view: SpeculationView): void {
    store.set(view);
  }

  function emitStep(
    outcome: SessionStep['outcome'],
    input: {
      utterance: string;
      scopedQuery: ScopedQuery;
      resolution: ResolutionResult;
      resolved: Extract<ResolutionResult, { outcome: 'resolved' }> | null;
      actionClass: ActionClass;
      confidence: number;
    },
  ): void {
    const step = SessionStep.parse({
      id: newId(),
      sessionId,
      ordinal: nextOrdinal(),
      utterance: input.utterance,
      intent: input.scopedQuery,
      resolution: input.resolution,
      elementId: input.resolved?.elementId ?? null,
      tier: input.resolved?.tier ?? input.resolution.tier,
      confidence: input.resolved ? input.confidence : null,
      actionClass: input.actionClass,
      latencyMs: Math.max(0, now() - current.onsetAt),
      outcome,
      evidence: [],
      createdAt: wallClock().toISOString(),
    });
    options.onStep?.(step);
  }

  function scopedQueryFor(
    parse: ParsedIntent,
    stateFingerprint: string,
    resolution: ResolutionResult,
  ): ScopedQuery {
    const keys = new Set<ElementKey>();
    for (const candidate of resolution.candidates) keys.add(candidate.elementKey);
    if (resolution.outcome === 'resolved') keys.add(resolution.elementKey);
    return {
      verb: parse.verb,
      targetPhrase: parse.targetPhrase,
      constraints: [...parse.constraints],
      stateFingerprint,
      candidateElementKeys: [...keys],
    };
  }

  function buildPayload(
    parse: ParsedIntent,
    resolved: Extract<ResolutionResult, { outcome: 'resolved' }>,
  ): ActionPayload {
    switch (parse.verb) {
      case 'navigate':
        return {
          verb: 'navigate',
          route: options.navRouteFor?.(resolved.elementId) ?? win.location.pathname,
        };
      case 'click':
        return { verb: 'click' };
      case 'type':
        return { verb: 'type', text: redact(parse.rawValue ?? ''), clearFirst: true };
      case 'focus':
        return { verb: 'focus' };
      case 'scroll': {
        const direction = SCROLL_DIRECTIONS.has(parse.rawValue ?? '')
          ? (parse.rawValue as 'up' | 'down' | 'top' | 'bottom')
          : 'down';
        return { verb: 'scroll', direction, amountPx: null };
      }
      case 'filter':
        return { verb: 'filter', text: redact(parse.rawValue ?? '') };
      case 'check':
        return { verb: 'check', assertion: parse.targetPhrase };
      case 'select':
        return { verb: 'select', option: redact(parse.rawValue ?? '') };
      case 'back':
        return { verb: 'back' };
    }
  }

  function dispatchContext(
    parse: ParsedIntent,
    resolution: ResolutionResult,
    scopedQuery: ScopedQuery,
    utterance: string,
  ): DispatchContext {
    const base: DispatchContext = {
      sessionId,
      ordinal: nextOrdinal(),
      utterance,
      intent: scopedQuery,
      resolution,
      onsetAt: current.onsetAt,
    };
    return parse.rawValue === undefined ? base : { ...base, rawText: parse.rawValue };
  }

  async function executeResolved(
    parse: ParsedIntent,
    resolved: Extract<ResolutionResult, { outcome: 'resolved' }>,
    element: Element,
    resolution: ResolutionResult,
    scopedQuery: ScopedQuery,
    utterance: string,
    actionClass: ActionClass,
    speculative: boolean,
    confirmed: boolean,
  ): Promise<void> {
    const request = ActionRequest.parse({
      id: newId(),
      sessionId,
      elementId: resolved.elementId,
      elementKey: resolved.elementKey,
      payload: buildPayload(parse, resolved),
      actionClass,
      tier: resolved.tier,
      confidence: resolved.confidence,
      speculative,
      confirmed,
      stateFingerprint: scopedQuery.stateFingerprint,
      issuedAt: wallClock().toISOString(),
    });
    await options.executor.dispatch(
      request,
      element,
      dispatchContext(parse, resolution, scopedQuery, utterance),
    );
  }

  function rollbackNow(): void {
    if (current.rollback === null) return;
    try {
      current.rollback.apply();
    } catch (error) {
      options.onError?.(error);
    }
    current.rollback = null;
    current.executedKey = null;
  }

  /** Window-level verbs (scroll, back) name no memory element; synthesise a resolved target. */
  function windowResolution(): Extract<ResolutionResult, { outcome: 'resolved' }> {
    return {
      outcome: 'resolved',
      elementId: VIEWPORT_ID,
      elementKey: VIEWPORT_KEY,
      confidence: 1,
      tier: 'T0',
      latencyMs: 0,
      candidates: [],
    };
  }

  function windowElement(): Element {
    return win.document.scrollingElement ?? win.document.documentElement;
  }

  async function process(hypothesis: Hypothesis, isFinal: boolean): Promise<void> {
    const rev = hypothesis.revision;
    if (rev < current.revision) return; // stale, out of order
    current.revision = rev;
    if (isFinal) current.final = true;

    const state = options.source.current();

    // ── An open disambiguation, answered by ordinal ──────────────────────────────────────────
    const open = options.resolver.pending?.() ?? null;
    if (open !== null) {
      const ordinal = parseOrdinal(hypothesis.transcript, open.choices.length);
      if (ordinal !== null) {
        // A pick is deliberate: it closes the list and teaches the system an alias. Neither is
        // done from a partial hypothesis that a revision could still take back.
        if (!isFinal) return;

        const chosen = options.resolver.choose?.(ordinal) ?? null;
        if (chosen !== null) {
          const answered = asked;
          asked = null;
          // The verb comes from the intent that *asked the question*, not from the word "two". A
          // tester who said "approve the acme order" and then answered "two" still means approve —
          // parsing the ordinal as a fresh command would silently downgrade it to a bare click and
          // lose the value they were typing, the direction they were scrolling, or the assertion.
          //
          // A list that outlived the intent that raised it — the worker restarted, the resolver was
          // rebuilt — still resolves, with whatever the ordinal itself parses as. Degraded, but the
          // tester's pick is not thrown away.
          await apply(
            answered?.parse ?? options.parser.parse(hypothesis.transcript),
            chosen,
            state,
            answered?.utterance ?? redact(hypothesis.transcript),
            true,
          );
          return;
        }
      }
    }

    const parse = options.parser.parse(hypothesis.transcript);
    const utterance = redact(hypothesis.transcript);

    // Window-level verbs resolve to the viewport without a lookup.
    const windowVerb = parse.verb === 'scroll' || parse.verb === 'back';

    let resolution: ResolutionResult;
    if (windowVerb) {
      resolution = windowResolution();
    } else if (parse.targetPhrase === '') {
      return; // nothing named yet
    } else {
      resolution = await options.resolver.resolve(parse.targetPhrase);
      // A newer hypothesis overtook this one while resolving: its result is the current truth.
      if (rev < current.revision) return;
      // Remember the intent behind an unanswered question, and forget it the moment one resolves.
      asked = options.resolver.pending?.() == null ? null : { parse, utterance };
    }

    await apply(parse, resolution, state, utterance, isFinal);
  }

  /**
   * Everything after a phrase has been turned into a resolution: classify, roll back a diverged
   * speculation, then stage or execute according to the taxonomy.
   *
   * Split out of {@link process} because a disambiguation answered by ordinal arrives here with a
   * resolution the resolver produced from the tester's pick and an intent parsed from an *earlier*
   * utterance. One body, so a pick is classified and gated by exactly the rules speech is.
   */
  async function apply(
    parse: ParsedIntent,
    resolution: ResolutionResult,
    state: { readonly stateFingerprint: string; readonly candidates: readonly Element[] },
    utterance: string,
    isFinal: boolean,
  ): Promise<void> {
    const windowVerb = parse.verb === 'scroll' || parse.verb === 'back';
    const resolved = resolution.outcome === 'resolved' ? resolution : null;
    const confidence = resolved ? resolved.confidence : (resolution.candidates[0]?.confidence ?? 0);
    const actionClass = classifyAction(parse.verb, confidence, classifyConfig, {
      screenDrifted: options.screenDrifted?.() ?? false,
    });
    const scopedQuery = scopedQueryFor(parse, state.stateFingerprint, resolution);

    // Divergence: a live speculative class-R effect whose target is no longer the answer is undone
    // before anything else happens.
    if (current.rollback !== null) {
      const newKey = resolved?.elementKey ?? null;
      if (newKey !== current.executedKey) {
        emitStep('rolled_back', {
          utterance,
          scopedQuery,
          resolution,
          resolved,
          actionClass,
          confidence,
        });
        rollbackNow();
      }
    }

    // Not resolved, or below threshold (class A): stage the reticle, never execute.
    if (resolved === null) {
      publish({
        phase: 'staged',
        rect: null,
        label: parse.targetPhrase || null,
        verb: parse.verb,
        actionClass,
        confidence,
        awaitingConfirmation: false,
      });
      if (isFinal)
        emitStep('staged', {
          utterance,
          scopedQuery,
          resolution,
          resolved: null,
          actionClass,
          confidence,
        });
      return;
    }

    const element = windowVerb
      ? windowElement()
      : options.locator.locate(state.stateFingerprint, state.candidates, resolved.elementKey);
    if (element === null) {
      // Resolved in memory but not present in the live DOM: stage, do not guess a click into space.
      publish({
        phase: 'staged',
        rect: null,
        label: parse.targetPhrase || null,
        verb: parse.verb,
        actionClass,
        confidence,
        awaitingConfirmation: false,
      });
      if (isFinal)
        emitStep('staged', {
          utterance,
          scopedQuery,
          resolution,
          resolved,
          actionClass,
          confidence,
        });
      return;
    }

    if (actionClass === 'R') {
      await handleReversible(parse, resolved, element, resolution, scopedQuery, utterance, isFinal);
      return;
    }

    // Class A, C or S: never executed from here. A partial only stages; a final opens the
    // confirmation gate. This is the branch the release-gate test guards — no path from a partial
    // reaches execute.
    //
    // `A` arrives here two ways: a resolution below threshold, and — since Phase 17 — any
    // resolution at all on a screen that has drifted from memory. Both get the same treatment,
    // which is the taxonomy's: pre-staged with a reticle, and executed only on an explicit yes.
    if (!isFinal) {
      publish({
        phase: 'staged',
        rect: rectOf(element),
        label: parse.targetPhrase || null,
        verb: parse.verb,
        actionClass,
        confidence,
        awaitingConfirmation: false,
      });
      return;
    }

    // Final, committing: stage, start the stability window, and wait for an explicit yes.
    current.pendingC = {
      resolved,
      element,
      parse,
      resolution,
      utterance,
      scopedQuery,
      actionClass,
      executed: false,
    };
    current.stable = false;
    current.confirmedByUser = false;
    current.cancelStability?.();
    current.cancelStability = schedule(() => {
      current.stable = true;
      void tryCommitPending();
    }, stabilityWindowMs);

    publish({
      phase: 'staged',
      rect: rectOf(element),
      label: parse.targetPhrase || null,
      verb: parse.verb,
      actionClass,
      confidence,
      awaitingConfirmation: true,
    });
  }

  async function handleReversible(
    parse: ParsedIntent,
    resolved: Extract<ResolutionResult, { outcome: 'resolved' }>,
    element: Element,
    resolution: ResolutionResult,
    scopedQuery: ScopedQuery,
    utterance: string,
    isFinal: boolean,
  ): Promise<void> {
    const alreadySpeculated =
      current.executedKey === resolved.elementKey && current.rollback !== null;

    if (isFinal) {
      // Commit. If the exact target was already executed speculatively, keep it — the speculative
      // dispatch *was* the execution; committing just means "do not undo it".
      if (alreadySpeculated) {
        current.rollback = null;
        current.executedKey = null;
      } else {
        await executeResolved(
          parse,
          resolved,
          element,
          resolution,
          scopedQuery,
          utterance,
          'R',
          false,
          false,
        );
      }
      publish({
        phase: 'executed',
        rect: rectOf(element),
        label: parse.targetPhrase || null,
        verb: parse.verb,
        actionClass: 'R',
        confidence: resolved.confidence,
        awaitingConfirmation: false,
      });
      return;
    }

    // A partial. Execute speculatively unless the same target is already running.
    if (!alreadySpeculated) {
      current.rollback = captureRollback(parse.verb, element, { window: win });
      current.executedKey = resolved.elementKey;
      await executeResolved(
        parse,
        resolved,
        element,
        resolution,
        scopedQuery,
        utterance,
        'R',
        true,
        false,
      );
    }
    publish({
      phase: 'aiming',
      rect: rectOf(element),
      label: parse.targetPhrase || null,
      verb: parse.verb,
      actionClass: 'R',
      confidence: resolved.confidence,
      // A reversible action needs no confirmation — it is already running, reversibly.
      awaitingConfirmation: false,
    });
  }

  async function tryCommitPending(): Promise<void> {
    const pending = current.pendingC;
    if (pending === null || pending.executed) return;
    if (!current.final || !current.stable || !current.confirmedByUser) return;

    pending.executed = true;
    await executeResolved(
      pending.parse,
      pending.resolved,
      pending.element,
      pending.resolution,
      pending.scopedQuery,
      pending.utterance,
      pending.actionClass,
      false,
      true,
    );
    current.pendingC = null;
    publish({
      phase: 'executed',
      rect: rectOf(pending.element),
      label: pending.parse.targetPhrase || null,
      verb: pending.parse.verb,
      actionClass: pending.actionClass,
      confidence: pending.resolved.confidence,
      awaitingConfirmation: false,
    });
  }

  function reset(newOnset: number): void {
    // A superseded, unconfirmed committing action is recorded as staged — it was offered, not taken.
    const pending = current.pendingC;
    if (pending !== null && !pending.executed) {
      emitStep('staged', {
        utterance: pending.utterance,
        scopedQuery: pending.scopedQuery,
        resolution: pending.resolution,
        resolved: pending.resolved,
        actionClass: pending.actionClass,
        confidence: pending.resolved.confidence,
      });
    }
    if (current.rollback !== null) rollbackNow();
    current.cancelStability?.();
    current = fresh(newOnset);
    publish(IDLE_VIEW);
  }

  return {
    view: store.observable,

    onSpeechOnset(): void {
      reset(now());
    },

    async onPartial(hypothesis): Promise<void> {
      try {
        await process(hypothesis, false);
      } catch (error) {
        options.onError?.(error);
      }
    },

    async onFinal(hypothesis): Promise<void> {
      try {
        await process(hypothesis, true);
      } catch (error) {
        options.onError?.(error);
      }
    },

    confirm(): void {
      current.confirmedByUser = true;
      void tryCommitPending().catch((error: unknown) => options.onError?.(error));
    },

    cancel(): void {
      // Abandoning the utterance abandons the question it raised. `reset` deliberately does not do
      // this — it also runs on speech onset, which is exactly when the tester is drawing breath to
      // answer — so the open choice is dropped here and nowhere else.
      asked = null;
      options.resolver.clearPending?.();
      reset(now());
    },

    dispose(): void {
      asked = null;
      current.cancelStability?.();
      store.close();
    },
  };
}
