import type { PageContext } from 'fingerprint';
import type { ElementRecord, MemorySnapshot, ResolutionResult } from 'protocol';

import { createCandidateBinder, type CandidateBinder } from './candidate-binder.js';
import { type ResolverConfig, resolveResolverConfig } from './config.js';
import type { Embedder } from './embedder.js';
import { buildAliasIndex, resolveT0, type AliasIndex } from './tier0.js';
import { createTier1Resolver, type Tier1Resolver } from './tier1.js';

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
 * Below the threshold it does not pick: T1 returns ranked candidates, and the caller (Phase 10's
 * speculation controller, Phase 11's T2 escalation) decides between disambiguation and escalation.
 * This phase stops at T1 — there is no T2 here.
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
}

export interface Resolver {
  /** The single entry point. Tries T0, then T1. */
  resolve(utterance: string): Promise<ResolutionResult>;
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

  const recordsByState = groupByState(options.snapshot);
  const binder: CandidateBinder = createCandidateBinder({
    recordsByState,
    ...(options.context === undefined ? {} : { context: options.context }),
  });
  const aliasIndex: AliasIndex = buildAliasIndex(options.snapshot.aliases);
  const tier1: Tier1Resolver = createTier1Resolver({ embedder: options.embedder });

  return {
    async resolve(utterance): Promise<ResolutionResult> {
      const { stateFingerprint, candidates } = options.source.current();
      const startedAt = now();

      const binding = binder.bind(stateFingerprint, candidates);

      const t0 = resolveT0(utterance, binding, aliasIndex, config, startedAt, now);
      if (t0 !== null) return t0;

      return tier1.resolve(utterance, binding, config, startedAt, now);
    },

    dispose(): void {
      tier1.clear();
    },
  };
}
