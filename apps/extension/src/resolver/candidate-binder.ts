import {
  compareFingerprints,
  computeFingerprint,
  DEFAULT_CONFIG,
  type FingerprintConfig,
  type PageContext,
  type ResolvedContext,
  resolveContext,
} from 'fingerprint';
import type { ElementFingerprint, ElementKey, ElementRecord } from 'protocol';

/**
 * Pairing live DOM nodes with the memory records they are believed to be.
 *
 * The scoped element index hands the resolver a set of live `Element`s; a `ResolutionResult`
 * carries an `elementId` and an `elementKey`, and a live node carries neither — both live in
 * memory, on `ElementRecord`. Binding is what closes that gap, and it is the same shared
 * fingerprint logic the indexer wrote the records with (CLAUDE.md rule #4): a live element's
 * fingerprint, compared against the screen's records.
 *
 * ## The bind, in order of cost
 *
 * 1. **Exact name+role.** Records are indexed by `accessibleNameHash`; a live element whose name
 *    hashes to a known one is bound to that record, or to the best of them by full fingerprint
 *    when a screen has several controls of the same name (a table of "View" links). This is the
 *    common case and it is a hash lookup.
 * 2. **Drifted.** A live element whose name matches no record — renamed, relabelled — is scored
 *    against every record on the screen and bound to the best, provided it clears `bindFloor`.
 *    Below the floor the element is left unbound and dropped: memory does not know it, so the
 *    resolver cannot name it, and inventing an identity is exactly the guess the taxonomy forbids.
 *
 * ## Cached per screen
 *
 * The scoped index memoises its candidate array between DOM changes, so the binding is cached
 * against that array's identity: the first resolution on a screen pays to fingerprint the
 * candidates, every repeat until the next mutation is free. That is what keeps T0 inside its 15 ms
 * budget on the repeat lookups that dominate a session — the first bind is amortised across them.
 */

export interface BoundCandidate {
  readonly record: ElementRecord;
  readonly element: Element;
  /** The freshly computed live fingerprint. Its `accessibleNameRedacted` is the live name T1
   * embeds and T0 matches against. */
  readonly live: ElementFingerprint;
  /** How well the live node still matches the stored fingerprint, in [0, 1]. Drift shows here. */
  readonly integrity: number;
}

export interface ScreenBinding {
  readonly stateFingerprint: string;
  readonly candidates: readonly BoundCandidate[];
  /** The scope, as the contract's `ScopedQuery.candidateElementKeys` wants it. */
  readonly candidateKeys: readonly ElementKey[];
}

export interface CandidateBinder {
  bind(stateFingerprint: string, liveCandidates: readonly Element[]): ScreenBinding;
}

export interface CandidateBinderOptions {
  /** Screen records grouped by state fingerprint — the resolver builds this from the snapshot. */
  readonly recordsByState: ReadonlyMap<string, readonly ElementRecord[]>;
  /** Fingerprinting context: redaction, geometry, weights. */
  readonly context?: PageContext;
  readonly config?: FingerprintConfig;
  /** Lowest fingerprint score at which a renamed element is still bound. Below it, unbound. */
  readonly bindFloor?: number;
}

const EMPTY_BINDING: ScreenBinding = {
  stateFingerprint: '',
  candidates: [],
  candidateKeys: [],
};

export function createCandidateBinder(options: CandidateBinderOptions): CandidateBinder {
  const config = options.config ?? DEFAULT_CONFIG;
  const bindFloor = options.bindFloor ?? config.integrityFloor;
  const pageContext: PageContext = options.context ?? {};
  // Resolved once for the scoring comparisons; `computeFingerprint` re-resolves the same defaults
  // from `pageContext` per element, which is a cheap object spread and keeps one redactor.
  const resolved: ResolvedContext = resolveContext(pageContext);

  // Records indexed per screen by accessible-name hash, so the common bind is a map lookup rather
  // than a scan. Built once per binder — the snapshot does not change under it.
  const byNameHash = new Map<string, Map<string, ElementRecord[]>>();
  for (const [state, records] of options.recordsByState) {
    const index = new Map<string, ElementRecord[]>();
    for (const record of records) {
      const bucket = index.get(record.fingerprint.accessibleNameHash);
      if (bucket === undefined) index.set(record.fingerprint.accessibleNameHash, [record]);
      else bucket.push(record);
    }
    byNameHash.set(state, index);
  }

  let cachedRef: readonly Element[] | null = null;
  let cachedState = '';
  let cached: ScreenBinding = EMPTY_BINDING;

  function bindOne(
    live: ElementFingerprint,
    element: Element,
    records: readonly ElementRecord[],
    nameIndex: Map<string, ElementRecord[]>,
  ): BoundCandidate | null {
    const exact = nameIndex.get(live.accessibleNameHash);
    if (exact !== undefined && exact.length > 0) {
      if (exact.length === 1) {
        const record = exact[0];
        if (record === undefined) return null;
        return {
          record,
          element,
          live,
          integrity: compareFingerprints(record.fingerprint, live, resolved).score,
        };
      }
      return bestOf(exact, live, element, 0);
    }
    // Renamed or unknown: score against the whole screen and require the floor.
    return bestOf(records, live, element, bindFloor);
  }

  function bestOf(
    records: readonly ElementRecord[],
    live: ElementFingerprint,
    element: Element,
    floor: number,
  ): BoundCandidate | null {
    let best: ElementRecord | null = null;
    let bestScore = -1;
    for (const record of records) {
      const score = compareFingerprints(record.fingerprint, live, resolved).score;
      if (score > bestScore) {
        bestScore = score;
        best = record;
      }
    }
    if (best === null || bestScore < floor) return null;
    return { record: best, element, live, integrity: bestScore };
  }

  return {
    bind(stateFingerprint, liveCandidates): ScreenBinding {
      // Same DOM (same memoised array) and same screen: the cached binding still holds.
      if (liveCandidates === cachedRef && stateFingerprint === cachedState) return cached;

      const records = options.recordsByState.get(stateFingerprint);
      const nameIndex = byNameHash.get(stateFingerprint);
      if (records === undefined || nameIndex === undefined || records.length === 0) {
        cachedRef = liveCandidates;
        cachedState = stateFingerprint;
        cached = { stateFingerprint, candidates: [], candidateKeys: [] };
        return cached;
      }

      const candidates: BoundCandidate[] = [];
      const keys = new Set<ElementKey>();
      for (const element of liveCandidates) {
        const live = computeFingerprint(element, pageContext);
        const bound = bindOne(live, element, records, nameIndex);
        if (bound === null) continue;
        candidates.push(bound);
        keys.add(bound.record.elementKey);
      }

      cachedRef = liveCandidates;
      cachedState = stateFingerprint;
      cached = { stateFingerprint, candidates, candidateKeys: [...keys] };
      return cached;
    },
  };
}
