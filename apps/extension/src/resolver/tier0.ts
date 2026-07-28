import type { Alias, ResolutionCandidate, ResolutionResult } from 'protocol';

import type { BoundCandidate, ScreenBinding } from './candidate-binder.js';
import type { ResolverConfig } from './config.js';
import { normalizePhrase } from './normalize.js';

/**
 * Tier 0 — the exact and alias hit, in the in-memory index. Budget < 15 ms, target > 80% of
 * commands (CLAUDE.md § "Resolution tiers").
 *
 * Two ways a phrase resolves without any scoring:
 *
 * - **Alias.** A learned `phrase → element` mapping, the compounding asset. Every T2 escalation
 *   writes one back, so a phrasing that cost 800 ms once costs microseconds forever after. The
 *   lookup is a normalised-string hash keyed by screen, falling back to the app-wide aliases.
 * - **Exact.** The utterance, normalised, equals a live candidate's accessible name or its
 *   element key. No learning required — "approve" resolves the Approve button the first time it
 *   is ever said.
 *
 * Drift is respected here rather than ignored: an alias or exact match whose bound element no
 * longer matches its stored fingerprint has its confidence discounted toward the floor, so a
 * relabelled or moved control pushes toward disambiguation instead of a confident wrong hit —
 * the behaviour the reversibility taxonomy asks for.
 *
 * A miss returns null: nothing matched exactly, and the caller escalates to T1.
 */

export interface AliasEntry {
  readonly elementId: string;
  readonly hits: number;
}

export interface AliasIndex {
  /** The element a phrase maps to on a screen, preferring a screen-scoped alias over app-wide. */
  lookup(phrase: string, stateFingerprint: string): AliasEntry | undefined;
  readonly size: number;
}

/**
 * Build the alias lookup from a snapshot's aliases.
 *
 * Phrases are normalised with the same function the utterance passes through, so the two ends of
 * a T0 comparison are folded identically. A screen-scoped alias (`stateFingerprint` set) shadows
 * an app-wide one for the same phrase — the same words can mean different controls on different
 * screens, and the more specific mapping wins.
 */
export function buildAliasIndex(aliases: readonly Alias[]): AliasIndex {
  const scoped = new Map<string, Map<string, AliasEntry>>();
  const appWide = new Map<string, AliasEntry>();
  let size = 0;

  for (const alias of aliases) {
    const phrase = normalizePhrase(alias.phrase);
    if (phrase === '') continue;
    const entry: AliasEntry = { elementId: alias.elementId, hits: alias.hits };
    size += 1;

    if (alias.stateFingerprint === null) {
      appWide.set(phrase, entry);
    } else {
      let screen = scoped.get(alias.stateFingerprint);
      if (screen === undefined) {
        screen = new Map<string, AliasEntry>();
        scoped.set(alias.stateFingerprint, screen);
      }
      screen.set(phrase, entry);
    }
  }

  return {
    size,
    lookup(phrase, stateFingerprint): AliasEntry | undefined {
      return scoped.get(stateFingerprint)?.get(phrase) ?? appWide.get(phrase);
    },
  };
}

/** Confidence for a strong match, discounted by how far the element has drifted. */
function discounted(base: number, integrity: number, floor: number): number {
  return Math.min(1, base * (floor + (1 - floor) * integrity));
}

function candidateOf(
  bound: BoundCandidate,
  confidence: number,
  alias: boolean,
): ResolutionCandidate {
  return {
    elementId: bound.record.id,
    elementKey: bound.record.elementKey,
    label: bound.live.accessibleNameRedacted,
    confidence,
    signalScores: alias
      ? { alias: 1, integrity: bound.integrity }
      : { exact: 1, integrity: bound.integrity },
  };
}

export function resolveT0(
  utterance: string,
  binding: ScreenBinding,
  aliases: AliasIndex,
  config: ResolverConfig,
  startedAt: number,
  now: () => number,
): ResolutionResult | null {
  const phrase = normalizePhrase(utterance);
  if (phrase === '') return null;

  const byId = new Map<string, BoundCandidate>();
  for (const candidate of binding.candidates) byId.set(candidate.record.id, candidate);

  // ── Alias ────────────────────────────────────────────────────────────────────────────────
  const alias = aliases.lookup(phrase, binding.stateFingerprint);
  if (alias !== undefined) {
    const bound = byId.get(alias.elementId);
    // The alias names an element that is on this screen and in scope: a T0 hit. An alias pointing
    // at something not currently reachable is not a hit — the tester cannot mean a control they
    // cannot see — so it falls through to exact matching and then to T1.
    if (bound !== undefined) {
      const confidence = discounted(config.aliasConfidence, bound.integrity, config.integrityFloor);
      if (confidence >= config.resolutionThreshold) {
        return {
          outcome: 'resolved',
          elementId: bound.record.id,
          elementKey: bound.record.elementKey,
          confidence,
          tier: 'T0',
          latencyMs: now() - startedAt,
          candidates: [candidateOf(bound, confidence, true)],
        };
      }
    }
  }

  // ── Exact ────────────────────────────────────────────────────────────────────────────────
  const exact: ResolutionCandidate[] = [];
  for (const candidate of binding.candidates) {
    const nameMatch = normalizePhrase(candidate.live.accessibleNameRedacted) === phrase;
    // Match the element segment — the last of `screen.component.element` — not the whole key: a
    // tester says "filter pending", never "orders orders filter pending". This is what lets an
    // icon-only control with a legible `data-testid` resolve the first time it is named.
    const elementSegment = candidate.record.elementKey.split('.').at(-1) ?? '';
    const keyMatch = normalizePhrase(elementSegment.replace(/[-_]+/g, ' ')) === phrase;
    if (!nameMatch && !keyMatch) continue;
    const confidence = discounted(
      config.exactConfidence,
      candidate.integrity,
      config.integrityFloor,
    );
    exact.push(candidateOf(candidate, confidence, false));
  }

  if (exact.length === 0) return null;

  exact.sort((a, b) => b.confidence - a.confidence);
  const [best, runnerUp] = exact;

  // One exact match that clears the bar, with no equal rival, is a resolution. Two controls with
  // the same name — a table of "View" links — is a genuine ambiguity the tester disambiguates by
  // ordinal, so it is returned as ranked candidates rather than guessed.
  if (
    best !== undefined &&
    best.confidence >= config.resolutionThreshold &&
    (runnerUp === undefined || best.confidence - runnerUp.confidence >= config.resolutionMargin)
  ) {
    return {
      outcome: 'resolved',
      elementId: best.elementId,
      elementKey: best.elementKey,
      confidence: best.confidence,
      tier: 'T0',
      latencyMs: now() - startedAt,
      candidates: [best],
    };
  }

  if (exact.length >= 2) {
    return { outcome: 'ambiguous', tier: 'T0', latencyMs: now() - startedAt, candidates: exact };
  }

  // A single exact match that did not clear the threshold — only possible through heavy drift —
  // is not something T0 should name. Let T1 look at it with embeddings.
  return null;
}
