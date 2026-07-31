import type { DistributionShape, FieldType } from 'protocol';

import { ISO_DATE, ISO_DATETIME, parseIsoTimestamp } from './iso-time.js';
import { isIdentifierLike } from './naming.js';
import { isVocabularyShaped, redactValue, safePrefix, sanitizeVocabulary } from './pii.js';
import type { FieldStatistics, JsonRecord } from './types.js';

/**
 * Value distributions, learned from an application's real records.
 *
 * docs/TEST-DATA-ENGINE.md § 3 is blunt about why this exists: "Never `faker` defaults. Sample
 * from *this application's* observed distribution so seeded data is indistinguishable from real
 * data and does not break downstream validation." A seeded order for £1.00 in an application
 * whose orders run from £800 to £240,000 is not a test fixture, it is a bug report waiting to be
 * filed against the wrong team.
 *
 * ## What is computed, and what is deliberately not
 *
 * One pass per field, producing exactly the four `DistributionShape` variants the contract
 * defines. There is no attempt at correlations between fields, at multi-modality, or at anything
 * else a statistician would reasonably want — the solver needs a plausible value per field and
 * the derived-rule observer covers the relationships that actually constrain a record.
 *
 * ## PII
 *
 * Nothing in this module stores a value except through `pii.ts`, and it stores one only for a
 * vocabulary it has established is closed. Everything else that leaves here is an aggregate:
 * a count, a range, a mean, a length, a character class. See that module for the guards.
 */

/** Above this length a string field is prose, and `text` rather than `string`. */
const TEXT_LENGTH_THRESHOLD = 120;

/** A field must be present on at least this many records before its shape means anything. */
const MIN_SAMPLE_FOR_SHAPE = 3;

/** Fewer records than this and `unique` would be an accident rather than an observation. */
const MIN_SAMPLE_FOR_UNIQUENESS = 10;

const DAY_MS = 86_400_000;

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Sample skewness. The one shape statistic the fit selection needs. */
function skewness(values: readonly number[], mean: number, stddev: number): number {
  if (stddev === 0 || values.length < 3) return 0;
  const total = values.reduce((sum, value) => sum + ((value - mean) / stddev) ** 3, 0);
  return total / values.length;
}

/**
 * Which family the observed numbers came from.
 *
 * Three cheap tests in an order chosen so the expensive-to-be-wrong case is checked first.
 * Getting `lognormal` wrong and sampling normally puts values near the mean, which for an amount
 * column spanning three orders of magnitude produces suspiciously uniform test data. Getting
 * `unknown` is not a failure: the sampler falls back to drawing within the observed range, which
 * is always defensible because every value it can produce is one the application has seen.
 */
type NumericFit = Extract<DistributionShape, { kind: 'numeric' }>['fit'];

function fitOf(values: readonly number[], mean: number, stddev: number): NumericFit {
  const skew = skewness(values, mean, stddev);

  if (values.every((value) => value > 0)) {
    const logs = values.map((value) => Math.log(value));
    const logMean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
    const logStddev = Math.sqrt(
      logs.reduce((sum, value) => sum + (value - logMean) ** 2, 0) / logs.length,
    );
    const logSkew = skewness(logs, logMean, logStddev);
    if (skew > 1 && Math.abs(logSkew) < Math.abs(skew)) return 'lognormal';
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const uniformStddev = (max - min) / Math.sqrt(12);
  if (
    Math.abs(skew) < 0.5 &&
    uniformStddev > 0 &&
    stddev / uniformStddev > 0.8 &&
    stddev / uniformStddev < 1.2
  ) {
    return 'uniform';
  }

  if (Math.abs(skew) < 0.5) return 'normal';
  return 'unknown';
}

function numericShape(values: readonly number[]): DistributionShape {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const stddev = Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
  );

  return {
    kind: 'numeric',
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    mean: round(mean),
    stddev: round(stddev),
    fit: fitOf(values, mean, stddev),
  };
}

/** Relative frequencies, rounded, with the largest bucket absorbing the rounding error. */
function categoricalShape(values: readonly string[]): DistributionShape {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);

  const frequencies: Record<string, number> = {};
  for (const [value, count] of counts) frequencies[value] = round(count / values.length);

  return { kind: 'categorical', frequencies };
}

/**
 * The learnable shape of a string field: what it starts with, how long it is, what it is made of.
 *
 * The character class is computed over what follows the prefix, because that is the part a
 * sampler has to invent. Knowing that `ORD-2001` is "mixed" is useless; knowing that everything
 * after `ORD-` is four numeric characters is what generates the next one.
 */
function stringPatternShape(values: readonly string[]): DistributionShape {
  const prefix = safePrefix(values);
  const bodies = prefix === null ? values : values.map((value) => value.slice(prefix.length));
  const joined = bodies.join('');

  const hasDigit = /\d/.test(joined);
  const hasAlpha = /[a-z]/i.test(joined);
  const hasOther = /[^a-z0-9]/i.test(joined);

  const charset = hasOther
    ? 'mixed'
    : hasDigit && hasAlpha
      ? 'alphanumeric'
      : hasDigit
        ? 'numeric'
        : 'alpha';

  return {
    kind: 'string_pattern',
    prefix,
    minLength: values.reduce((least, value) => Math.min(least, value.length), Infinity),
    maxLength: values.reduce((most, value) => Math.max(most, value.length), 0),
    charset,
  };
}

/** Observed dates as day offsets from now, which is how the solver has to reason about them. */
function temporalShape(values: readonly string[]): DistributionShape | null {
  const now = Date.now();
  const offsets: number[] = [];

  for (const value of values) {
    const parsed = parseIsoTimestamp(value);
    if (parsed === null) return null;
    offsets.push(round((parsed - now) / DAY_MS, 2));
  }

  return {
    kind: 'temporal',
    minOffsetDays: Math.min(...offsets),
    maxOffsetDays: Math.max(...offsets),
  };
}

/**
 * Whether every observed value being distinct is a claim worth recording.
 *
 * Restricted to identifiers — integers, and strings with a learned code prefix — because those
 * are the fields where distinctness is a rule the application enforces. Fifty distinct customer
 * names are distinct by coincidence, and marking that column unique would make the solver
 * decline perfectly good values.
 *
 * The direction to be wrong in is claiming uniqueness: the cost is one collision check the
 * sampler would probably have done anyway, against the cost of composing a duplicate the
 * application rejects.
 */
function looksUnique(
  type: FieldType,
  shape: DistributionShape | null,
  distinctCount: number,
  presentCount: number,
): boolean {
  if (presentCount < MIN_SAMPLE_FOR_UNIQUENESS || distinctCount !== presentCount) return false;
  if (type === 'integer') return true;
  return shape?.kind === 'string_pattern' && shape.prefix !== null;
}

/** Statistics for one field, from the values observed for it. */
function summarizeField(name: string, values: readonly unknown[]): FieldStatistics | null {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length < MIN_SAMPLE_FOR_SHAPE) return null;

  const distributionOf = (
    type: FieldType,
    shape: DistributionShape | null,
    distinctCount: number,
    enumValues: readonly string[] | null,
  ): FieldStatistics => ({
    name,
    type,
    distribution: shape === null ? null : { shape, sampleSize: present.length, distinctCount },
    enumValues,
    unique: looksUnique(type, shape, distinctCount, present.length),
    presentCount: present.length,
  });

  if (present.every((value) => typeof value === 'boolean')) {
    const asText = present.map((value) => String(value));
    return distributionOf('boolean', categoricalShape(asText), new Set(asText).size, null);
  }

  if (present.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    const numbers = present as number[];
    const type: FieldType = numbers.every((value) => Number.isInteger(value))
      ? 'integer'
      : 'number';
    return distributionOf(type, numericShape(numbers), new Set(numbers).size, null);
  }

  if (present.every((value) => typeof value === 'string')) {
    const strings = present;

    if (strings.every((value) => ISO_DATE.test(value))) {
      const shape = temporalShape(strings);
      return distributionOf('date', shape, new Set(strings).size, null);
    }
    if (strings.every((value) => ISO_DATETIME.test(value))) {
      const shape = temporalShape(strings);
      return distributionOf('datetime', shape, new Set(strings).size, null);
    }

    const distinct = new Set(strings);

    // Identifier-shaped values are keys into another collection, however few of them there are.
    // Eight `ACC-100x` across fifty orders passes every cardinality test a status column passes,
    // and recording it as a vocabulary would freeze this week's account list into memory as the
    // legal values of the field. The referential graph is what that column actually is; leaving
    // it as a plain string here is what lets `references.ts` say so.
    if (!isIdentifierLike(strings) && isVocabularyShaped(distinct.size, strings.length)) {
      const vocabulary = sanitizeVocabulary([...distinct]);
      if (vocabulary !== null) {
        const redacted = strings.map((value) => redactValue(value));
        return distributionOf(
          'enum',
          categoricalShape(redacted),
          new Set(redacted).size,
          vocabulary,
        );
      }
    }

    // Not a vocabulary: only the shape survives. The values themselves stop here.
    const redacted = strings.map((value) => redactValue(value));
    const type: FieldType =
      redacted.reduce((most, value) => Math.max(most, value.length), 0) > TEXT_LENGTH_THRESHOLD
        ? 'text'
        : 'string';
    return distributionOf(type, stringPatternShape(redacted), distinct.size, null);
  }

  // Values that disagree about their own type — a field an application populates inconsistently.
  // Recorded so the schema knows it exists, with no distribution, because there is no single
  // shape to record and inventing one would be worse than admitting the gap.
  return {
    name,
    type: 'string',
    distribution: null,
    enumValues: null,
    unique: false,
    presentCount: present.length,
  };
}

/**
 * Every field of a collection, including the members of any repeated group.
 *
 * A group is reported twice over: once as a `group` field whose distribution is the *number of
 * members* per record — which is what a "three line items" cardinality constraint is checked
 * against — and once per member as a flattened `group.member` field with statistics of its own.
 * Flattening is what lets the sum rule over `lines[].amount` find a distribution to sample from
 * when it needs to invent a fourth line.
 */
export function summarizeCollection(records: readonly JsonRecord[]): FieldStatistics[] {
  const columns = new Map<string, unknown[]>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      const column = columns.get(key);
      if (column === undefined) columns.set(key, [record[key]]);
      else column.push(record[key]);
    }
  }

  const statistics: FieldStatistics[] = [];

  for (const [name, values] of columns) {
    const present = values.filter((value) => value !== null && value !== undefined);

    if (present.length > 0 && present.every((value) => Array.isArray(value))) {
      const groups = present as unknown[][];
      const sizes = groups.map((group) => group.length);

      statistics.push({
        name,
        type: 'group',
        distribution: {
          shape: numericShape(sizes),
          sampleSize: groups.length,
          distinctCount: new Set(sizes).size,
        },
        enumValues: null,
        unique: false,
        presentCount: groups.length,
      });

      const members = groups.flat().filter(isRecord);
      if (members.length > 0) {
        for (const member of summarizeCollection(members)) {
          statistics.push({ ...member, name: `${name}.${member.name}` });
        }
      }
      continue;
    }

    const summary = summarizeField(name, values);
    if (summary !== null) statistics.push(summary);
  }

  return statistics;
}
