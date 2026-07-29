import { defaultRedactor, type PageContext, type Redactor } from 'fingerprint';
import type { ElementRecord, MemorySnapshot, ResolutionResult } from 'protocol';

import { createCandidateBinder, type CandidateBinder } from './candidate-binder.js';
import { type ResolverConfig, resolveResolverConfig } from './config.js';
import {
  buildDisambiguation,
  chooseByOrdinal,
  parseOrdinal,
  type Disambiguation,
} from './disambiguation.js';
import type { Embedder } from './embedder.js';
import { buildAliasIndex, resolveT0, type AliasIndex } from './tier0.js';
import { createTier1Resolver, type Tier1Resolver } from './tier1.js';
import {
  createTier2Resolver,
  writeBackCorrection,
  type AliasSink,
  type EscalateTransport,
  type Tier2Resolver,
} from './tier2.js';

/**
 * The resolver — a single `resolve(utterance)` that tries T0, then T1, and returns a
 * `ResolutionResult` carrying the tier and confidence it cost (docs/BUILD-PLAN.md Phase 8).
 *
 * It owns no page state. It reads the current screen and scoped candidate set through a
 * {@link ResolverStateSource} — the content script wires that to the runtime state engine's
 * `state` and `scopedIndex`; a test wires it to a fixture. That is what lets the whole tier stack
 * be exercised deterministically without a live browser, while the same code runs against the
 * real DOM in the extension.
 *
 * Below the threshold it does not pick: T1 returns ranked candidates, and — when a transport is
 * supplied — the phrase escalates to T2, the gateway's small fast model. Still below threshold, the
 * ranked candidates become a numbered list the tester answers by speaking an ordinal.
 *
 * ## The compounding loop closes here
 *
 * A T2 pick above threshold and a tester's disambiguation choice both enqueue an alias write-back,
 * so the *next* time that phrasing is said it is a T0 hit and never leaves the device (CLAUDE.md
 * § "Resolution tiers"). The queue that batches them lives in the service worker, which holds the
 * token; this file only reports what was learned, through `onAlias`.
 */

export interface ResolverStateSource {
  /** The current screen fingerprint and the live scoped candidate set, from the state engine. */
  current(): { readonly stateFingerprint: string; readonly candidates: readonly Element[] };
}

export interface ResolverOptions {
  readonly snapshot: MemorySnapshot;
  readonly embedder: Embedder;
  readonly source: ResolverStateSource;
  readonly config?: Partial<ResolverConfig>;
  /** Fingerprinting context for binding — redaction, geometry, weights. */
  readonly context?: PageContext;
  /** Clock, for deterministic latency in tests and benches. Defaults to `performance.now`. */
  readonly now?: () => number;
  /**
   * How a T2 escalation reaches the gateway. Absent means no T2: the resolver stops at T1 and
   * disambiguates, which is the correct degraded behaviour when the worker has no session.
   */
  readonly escalate?: EscalateTransport;
  /** Where a learned alias goes. Absent means escalate without learning. */
  readonly onAlias?: AliasSink;
  /** Redactor for anything leaving the page — the escalation prompt and a held phrase. */
  readonly redact?: Redactor;
  readonly onError?: (error: unknown) => void;
}

export interface Resolver {
  /**
   * The single entry point. Tries T0, then T1, then T2.
   *
   * While a disambiguation is open, an utterance that is *only* a spoken ordinal answers it
   * instead — "two" picks the second candidate, records the correction, and resolves.
   */
  resolve(utterance: string): Promise<ResolutionResult>;
  /** The open disambiguation, if the last resolution asked the tester to choose. */
  pending(): Disambiguation | null;
  /**
   * Answer the open disambiguation by ordinal — the HUD's click path; speech goes through
   * `resolve`. Writes the correction back as an alias. Null if no such choice is on offer.
   */
  choose(ordinal: number): ResolutionResult | null;
  /** Abandon the open disambiguation without choosing. */
  clearPending(): void;
  dispose(): void;
}

function defaultNow(): number {
  return typeof performance === 'object' ? performance.now() : Date.now();
}

/** Group a snapshot's elements by the state fingerprint of the screen they belong to. */
function groupByState(snapshot: MemorySnapshot): Map<string, ElementRecord[]> {
  const stateByScreen = new Map<string, string>();
  for (const screen of snapshot.screens) stateByScreen.set(screen.id, screen.stateFingerprint);

  const byState = new Map<string, ElementRecord[]>();
  for (const element of snapshot.elements) {
    const state = stateByScreen.get(element.screenId);
    if (state === undefined) continue;
    const bucket = byState.get(state);
    if (bucket === undefined) byState.set(state, [element]);
    else bucket.push(element);
  }
  return byState;
}

export function createResolver(options: ResolverOptions): Resolver {
  const config: ResolverConfig = resolveResolverConfig(options.config);
  const now = options.now ?? defaultNow;
  const redact = options.redact ?? defaultRedactor;

  const recordsByState = groupByState(options.snapshot);
  const binder: CandidateBinder = createCandidateBinder({
    recordsByState,
    ...(options.context === undefined ? {} : { context: options.context }),
  });
  const aliasIndex: AliasIndex = buildAliasIndex(options.snapshot.aliases);
  const tier1: Tier1Resolver = createTier1Resolver({ embedder: options.embedder });
  const tier2: Tier2Resolver | null =
    options.escalate === undefined
      ? null
      : createTier2Resolver({
          transport: options.escalate,
          redact,
          ...(options.onAlias === undefined ? {} : { onAlias: options.onAlias }),
          ...(options.onError === undefined ? {} : { onError: options.onError }),
        });

  let pending: Disambiguation | null = null;

  /** The tester's spoken choice, turned into a resolution and an alias. */
  function accept(open: Disambiguation, ordinal: number): ResolutionResult | null {
    const candidate = chooseByOrdinal(open, ordinal);
    if (candidate === null) return null;
    pending = null;

    // The correction, learned. Written against the phrase that failed, so the *next* utterance of
    // that phrase is a T0 hit — the same loop a T2 pick feeds, from a better teacher.
    writeBackCorrection(options.onAlias, open.phrase, candidate.elementId, open.stateFingerprint);

    return {
      outcome: 'resolved',
      elementId: candidate.elementId,
      elementKey: candidate.elementKey,
      // The tester named it. Nothing the resolver could compute is more certain than that, and a
      // discounted confidence here would push a class-C action back into the ambiguous branch the
      // tester has just resolved by hand.
      confidence: 1,
      tier: open.tier,
      latencyMs: 0,
      candidates: [candidate],
    };
  }

  return {
    async resolve(utterance): Promise<ResolutionResult> {
      // An open list first: while the tester is being asked to choose, "two" is an answer, not a
      // new command. `parseOrdinal` only accepts an utterance that is *nothing but* an ordinal,
      // so "approve order two" still resolves normally.
      const open = pending;
      if (open !== null) {
        const ordinal = parseOrdinal(utterance, open.choices.length);
        if (ordinal !== null) {
          const chosen = accept(open, ordinal);
          if (chosen !== null) return chosen;
        }
      }

      const { stateFingerprint, candidates } = options.source.current();
      const startedAt = now();

      const binding = binder.bind(stateFingerprint, candidates);

      const t0 = resolveT0(utterance, binding, aliasIndex, config, startedAt, now);
      if (t0 !== null) {
        pending = null;
        return t0;
      }

      let result = await tier1.resolve(utterance, binding, config, startedAt, now);

      // T2 is reached only when T0 and T1 have both failed to name an element — the phase's
      // "escalate only when T0 and T1 both fall below threshold", and what keeps its share of
      // commands under 5%.
      if (result.outcome !== 'resolved' && tier2 !== null) {
        result = await tier2.resolve(utterance, binding, config, startedAt, now, result);
      }

      // The phrase is redacted before it is held: a disambiguation that is never answered still
      // ends up in the HUD, and an answered one is persisted as vocabulary.
      pending =
        result.outcome === 'resolved'
          ? null
          : buildDisambiguation(redact(utterance), binding.stateFingerprint, result, config);

      return result;
    },

    pending(): Disambiguation | null {
      return pending;
    },

    choose(ordinal): ResolutionResult | null {
      return pending === null ? null : accept(pending, ordinal);
    },

    clearPending(): void {
      pending = null;
    },

    dispose(): void {
      pending = null;
      tier1.clear();
    },
  };
}
