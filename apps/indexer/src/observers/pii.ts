import { defaultRedactor } from 'fingerprint';

/**
 * The one place an observed value is allowed to become something that gets stored.
 *
 * CLAUDE.md § "PII rule": Product Memory stores structure, never content. The schema observers
 * are the part of the system most likely to break that rule by accident, because their input is
 * a customer's live records — fifty rows of names, addresses, amounts and free text — and their
 * output has to describe those records well enough to generate plausible new ones.
 *
 * The resolution is that **statistics leave; values do not**. A numeric field contributes a
 * range and a mean. A date field contributes two offsets. A free-text field contributes a length
 * range and a character class. Nothing that reaches `field_specs` can be traced back to a row.
 *
 * ## The one exception, and the two guards on it
 *
 * A learned enum vocabulary *is* a set of values — `{Draft, Pending approval, Approved}` — and
 * the contract stores it as `enumValues` because a solver cannot satisfy `status = pending`
 * without knowing that `pending` is a legal value. So values are retained in exactly one case,
 * behind two guards:
 *
 * 1. **The vocabulary must be closed.** Either the application declared it with a closed-set
 *    control, or the values repeat often enough across records to be a vocabulary rather than a
 *    column of data. {@link isVocabularyShaped} is that test.
 * 2. **Every retained value is redacted and bounded.** A vocabulary member longer than
 *    {@link MAX_VOCABULARY_VALUE_LENGTH} is prose, and prose is content.
 *
 * A learned string *prefix* is the other place a fragment of real data could escape, and
 * {@link safePrefix} exists to make sure it does not.
 */

/** Beyond this, a "vocabulary member" is a sentence. */
export const MAX_VOCABULARY_VALUE_LENGTH = 64;

/** More distinct values than this is a collection being enumerated, not a vocabulary. */
export const MAX_VOCABULARY_SIZE = 12;

/**
 * At most this share of the sample may be distinct.
 *
 * Twelve distinct statuses across a thousand orders is a vocabulary. Twelve distinct values
 * across fifteen records is a column of data that happens to be short.
 */
export const MAX_VOCABULARY_DISTINCT_RATIO = 0.25;

/** A learned prefix longer than this is a value, not a code. */
const MAX_PREFIX_LENGTH = 8;

/** Redact a value observed in a customer's data. Never store a string that skipped this. */
export function redactValue(value: string): string {
  return defaultRedactor(value);
}

/**
 * Whether a set of observed values is a vocabulary rather than a column of data.
 *
 * Both conditions have to hold, and the ratio is the one that does the work: it is what stops
 * eight recycled customer names in fifty orders — a cardinality any status field would envy —
 * from being written into memory as an enum.
 *
 * This is a heuristic and is stated as one. It can still misfire on a genuinely low-cardinality
 * free-text column, which is why every value it admits is redacted and length-bounded, and why
 * the console can correct a vocabulary a QA lead knows to be wrong. Where the application
 * declared a closed set with a `<select>`, the declaration is used instead and this test is not
 * consulted at all.
 */
export function isVocabularyShaped(distinctCount: number, sampleSize: number): boolean {
  if (sampleSize === 0 || distinctCount === 0) return false;
  if (distinctCount > MAX_VOCABULARY_SIZE) return false;
  return distinctCount / sampleSize <= MAX_VOCABULARY_DISTINCT_RATIO;
}

/**
 * Redact, bound and de-duplicate a candidate vocabulary. Null when it is not one after all.
 *
 * Redaction can collapse members — a vocabulary of two email addresses becomes one `[email]` —
 * and a vocabulary that collapses to a single member carries no information, so it is dropped.
 */
export function sanitizeVocabulary(values: readonly string[]): string[] | null {
  const kept = new Set<string>();

  for (const value of values) {
    const redacted = redactValue(value);
    if (redacted === '' || redacted.length > MAX_VOCABULARY_VALUE_LENGTH) return null;
    kept.add(redacted);
  }

  if (kept.size < 2) return null;
  return [...kept].sort();
}

/**
 * The longest shared prefix of a set of values, when keeping it is safe.
 *
 * `ORD-` across fifty order references is structure: a sampler needs it to generate a reference
 * the application will accept. The whole of `Kilnhurst Diaphragms` across fifty rows that all
 * happen to start the same way is content, and the difference has to be decided mechanically.
 *
 * Three guards, and a value has to clear all of them:
 *
 * - **At least two distinct values.** One value's "shared prefix" is the value.
 * - **No whitespace.** A code prefix is `INV-`; anything with a space in it is prose.
 * - **Short, and shorter than the shortest value.** A prefix that is most of a value is a value.
 *
 * Returns null when there is no prefix, or when keeping it would not be safe. Null is a fine
 * answer — it means values of this field share no learnable prefix, which is true of most.
 */
export function safePrefix(values: readonly string[]): string | null {
  const distinct = new Set(values);
  if (distinct.size < 2) return null;

  const [first, ...rest] = values;
  if (first === undefined) return null;

  let prefix = first;
  for (const value of rest) {
    let length = 0;
    while (length < prefix.length && length < value.length && prefix[length] === value[length]) {
      length += 1;
    }
    prefix = prefix.slice(0, length);
    if (prefix === '') return null;
  }

  const shortest = values.reduce((least, value) => Math.min(least, value.length), Infinity);
  if (prefix.length > MAX_PREFIX_LENGTH) return null;
  if (prefix.length >= shortest) return null;
  if (/\s/.test(prefix)) return null;

  return prefix;
}
