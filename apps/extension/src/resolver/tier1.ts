import type { ResolutionCandidate, ResolutionResult } from 'protocol';

import type { BoundCandidate, ScreenBinding } from './candidate-binder.js';
import type { ResolverConfig } from './config.js';
import { dot, type Embedder } from './embedder.js';

/**
 * Tier 1 — local embedding kNN over the scoped candidate set. Budget < 40 ms, ~15% of commands
 * (CLAUDE.md § "Resolution tiers").
 *
 * When nothing matched exactly, the utterance and each candidate's accessible name are embedded
 * with the bundled bge-small model and ranked by cosine similarity. "show me only the pending
 * ones" never equals the label "Pending", but their embeddings are close, and that is the whole
 * point of the tier: it catches the paraphrase T0 cannot, without the network hop or the latency
 * of T2.
 *
 * ## Embedded once per screen, per docs/BUILD-PLAN.md Phase 8
 *
 * "Embed only the scoped candidates' accessible names, cached per stateFingerprint so repeat
 * lookups on the same screen are free." The candidate vectors are cached against the screen and
 * the exact candidate set; only the *query* is embedded per utterance. So the second command on a
 * screen pays for one short embedding, not for re-embedding every control on it — which is what
 * keeps T1 inside 40 ms once a screen is warm.
 *
 * The cache is invalidated the moment the candidate set changes: a mutation that adds or removes
 * a control changes the binding, its signature no longer matches, and the vectors are recomputed.
 */

export interface Tier1Resolver {
  resolve(
    utterance: string,
    binding: ScreenBinding,
    config: ResolverConfig,
    startedAt: number,
    now: () => number,
  ): Promise<ResolutionResult>;
  /** Drop cached vectors. Called when the snapshot is replaced. */
  clear(): void;
}

interface ScreenEmbeddings {
  readonly signature: string;
  readonly candidates: readonly BoundCandidate[];
  readonly vectors: readonly Float32Array[];
}

export interface Tier1Options {
  readonly embedder: Embedder;
}

export function createTier1Resolver(options: Tier1Options): Tier1Resolver {
  const { embedder } = options;
  const cache = new Map<string, ScreenEmbeddings>();

  /** The text a candidate is embedded as: its live accessible name, or its key when it has none. */
  function textOf(candidate: BoundCandidate): string {
    const name = candidate.live.accessibleNameRedacted.trim();
    if (name !== '') return name;
    // A control with no accessible name — an icon-only button — still has a legible element key.
    // Embedding `orders.filter.pending` as words gives T1 something to match "pending" against.
    return candidate.record.elementKey.replace(/[._-]+/g, ' ');
  }

  async function vectorsFor(binding: ScreenBinding): Promise<ScreenEmbeddings> {
    const signature = binding.candidates.map((candidate) => candidate.record.elementKey).join('|');
    const cached = cache.get(binding.stateFingerprint);
    if (cached?.signature === signature) return cached;

    const vectors = await embedder.embed(binding.candidates.map(textOf));
    const entry: ScreenEmbeddings = { signature, candidates: binding.candidates, vectors };
    cache.set(binding.stateFingerprint, entry);
    return entry;
  }

  return {
    clear(): void {
      cache.clear();
    },

    async resolve(utterance, binding, config, startedAt, now): Promise<ResolutionResult> {
      if (binding.candidates.length === 0) {
        return { outcome: 'not_found', tier: 'T1', latencyMs: now() - startedAt, candidates: [] };
      }

      const screen = await vectorsFor(binding);
      const [queryVector] = await embedder.embed([config.queryInstruction + utterance]);
      if (queryVector === undefined) {
        return { outcome: 'not_found', tier: 'T1', latencyMs: now() - startedAt, candidates: [] };
      }

      const scored: ResolutionCandidate[] = [];
      for (let i = 0; i < screen.candidates.length; i += 1) {
        const candidate = screen.candidates[i];
        const vector = screen.vectors[i];
        if (candidate === undefined || vector === undefined) continue;
        // Cosine similarity, clamped into [0, 1]: both vectors are L2-normalised, so the dot
        // product is the cosine, and a rare negative is floored rather than shown as a confidence.
        const similarity = Math.max(0, Math.min(1, dot(queryVector, vector)));
        scored.push({
          elementId: candidate.record.id,
          elementKey: candidate.record.elementKey,
          label: candidate.live.accessibleNameRedacted,
          confidence: similarity,
          signalScores: { embedding: similarity, integrity: candidate.integrity },
        });
      }

      scored.sort((a, b) => b.confidence - a.confidence);
      const shortlist = scored.filter((candidate) => candidate.confidence >= config.candidateFloor);
      const [best, runnerUp] = shortlist;
      const latencyMs = now() - startedAt;

      if (
        best !== undefined &&
        best.confidence >= config.t1Threshold &&
        (runnerUp === undefined || best.confidence - runnerUp.confidence >= config.t1Margin)
      ) {
        return {
          outcome: 'resolved',
          elementId: best.elementId,
          elementKey: best.elementKey,
          confidence: best.confidence,
          tier: 'T1',
          latencyMs,
          candidates: shortlist,
        };
      }

      if (shortlist.length >= 2) {
        return { outcome: 'ambiguous', tier: 'T1', latencyMs, candidates: shortlist };
      }

      // Nothing cleared the bar and there is nothing to choose between: the honest answer is that
      // the phrase did not match, which the caller escalates to T2 in Phase 11.
      return { outcome: 'not_found', tier: 'T1', latencyMs, candidates: [] };
    },
  };
}
