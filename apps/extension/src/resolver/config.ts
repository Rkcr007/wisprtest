/**
 * The resolver's tunables.
 *
 * The threshold/margin trio mirrors `packages/fingerprint`'s `DEFAULT_CONFIG` so a decision made
 * at T0 and the same decision made by the shared scorer agree on what "resolved" means. The T1
 * pair is separate because embedding cosine similarities live on a different scale from the
 * fingerprint scores — a good bge paraphrase match sits around 0.7–0.9, an unrelated pair around
 * 0.3–0.5 — so it gets its own bar rather than borrowing one calibrated for a different signal.
 *
 * None of these are constants scattered through the code: every entry point takes a
 * `ResolverConfig`, and Phase 19's benchmark gates will tune them against a real corpus.
 */
export interface ResolverConfig {
  /** Confidence a candidate must reach to be named rather than disambiguated. */
  readonly resolutionThreshold: number;
  /** How far the best must lead the runner-up before it counts as resolved. */
  readonly resolutionMargin: number;
  /** Lowest confidence worth offering in a disambiguation list. */
  readonly candidateFloor: number;
  /** How far drift can discount a strong match before it stops being one. */
  readonly integrityFloor: number;
  /** Confidence of an undrifted alias hit. */
  readonly aliasConfidence: number;
  /** Confidence of an undrifted exact name/key match. */
  readonly exactConfidence: number;
  /** Cosine similarity a T1 candidate must reach to be named. */
  readonly t1Threshold: number;
  /** Cosine lead the best T1 candidate must hold over the runner-up. */
  readonly t1Margin: number;
  /**
   * Confidence a T2 pick must reach to be named — and, identically, to be written back.
   *
   * One number governs both because they are the same judgement: a pick the resolver would act on
   * is a pick worth teaching, and a pick it would not act on must not be persisted as vocabulary
   * that makes the same uncertain answer instant next time. Set above `t1Threshold` because a
   * model's stated confidence is cheaper to produce than a cosine and deserves a higher bar.
   */
  readonly t2Threshold: number;
  /**
   * How many candidates a disambiguation list offers.
   *
   * Three, because the tester picks by *speaking* an ordinal — "one, two, or three" — and a spoken
   * list longer than that is one the tester has to re-read rather than answer.
   */
  readonly disambiguationLimit: number;
  /**
   * The bge retrieval instruction, prepended to the *query* only.
   *
   * bge-small-en-v1.5 was trained for asymmetric retrieval: the query carries this instruction and
   * the documents — here, the candidates' accessible names — do not. Omitting it measurably
   * degrades ranking, so it is on by default and overridable rather than hard-coded.
   */
  readonly queryInstruction: string;
}

export const DEFAULT_RESOLVER_CONFIG: ResolverConfig = {
  resolutionThreshold: 0.72,
  resolutionMargin: 0.08,
  candidateFloor: 0.25,
  integrityFloor: 0.6,
  aliasConfidence: 0.99,
  exactConfidence: 0.98,
  t1Threshold: 0.62,
  t1Margin: 0.04,
  t2Threshold: 0.7,
  disambiguationLimit: 3,
  queryInstruction: 'Represent this sentence for searching relevant passages: ',
};

export function resolveResolverConfig(overrides?: Partial<ResolverConfig>): ResolverConfig {
  return overrides === undefined
    ? DEFAULT_RESOLVER_CONFIG
    : { ...DEFAULT_RESOLVER_CONFIG, ...overrides };
}
