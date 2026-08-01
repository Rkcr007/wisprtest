import type { DerivedRuleSpec } from 'protocol';

import { parseIsoTimestamp } from './iso-time.js';
import type { JsonRecord, ObservedDerivedRule } from './types.js';

/**
 * Derived-field inference over observed records.
 *
 * docs/TEST-DATA-ENGINE.md § 2.3, quoted in full because it is the whole specification:
 *
 * > Given observed records, test simple arithmetic and temporal hypotheses […] Keep the
 * > hypothesis space small and explicit — sum, count, min/max, date offset, concatenation.
 * > **This is not a general program synthesiser and must not become one.**
 *
 * The hypothesis set is therefore exactly the six variants of `DerivedRuleSpec` and nothing
 * else. There is no search over expressions, no composition of rules, no arithmetic beyond what
 * is enumerated here. The file is short by design, and a change that makes it longer should be
 * treated as a change of direction rather than an improvement.
 *
 * ## Why a rule must hold everywhere
 *
 * A rule that holds for 127 of 128 records is not a rule with confidence 0.99 — it is a
 * coincidence with a counterexample. The solver evaluates derived rules *last* and overwrites
 * whatever the sampler produced, so a wrong rule silently corrupts every composed record of that
 * entity. A single exception rejects the hypothesis outright.
 *
 * ## What confidence means here
 *
 * Not "how often it held" — that is always 1, because anything less is not recorded. Confidence
 * is *how much evidence stands behind the claim*: `amount = Σ lines[].amount` holding across six
 * records is a plausible coincidence, and holding across a hundred is not. It saturates at
 * {@link CONFIDENT_SAMPLE_SIZE}, which reproduces § 2.3's own worked example — 128 records out
 * of 128, confidence 1.0.
 */

/** Sample size at which a rule that held everywhere is believed completely. */
export const CONFIDENT_SAMPLE_SIZE = 50;

/** Below this, "held for every record" is not yet a statement about the application. */
const MIN_SAMPLE = 5;

/** Half a cent. Money arrives as a float and floats do not add up exactly. */
const NUMERIC_TOLERANCE = 0.005;

/** Separators tried for concatenation. Explicit and closed, like everything else here. */
const SEPARATORS: readonly string[] = ['', ' ', '-', '/', ' — ', ' · ', ', '];

const DAY_MS = 86_400_000;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberAt(record: JsonRecord, field: string): number | null {
  const value = record[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringAt(record: JsonRecord, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' ? value : null;
}

function timeAt(record: JsonRecord, field: string): number | null {
  return parseIsoTimestamp(record[field]);
}

function groupAt(record: JsonRecord, field: string): JsonRecord[] | null {
  const value = record[field];
  if (!Array.isArray(value)) return null;
  return value.every(isRecord) ? value : null;
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= NUMERIC_TOLERANCE;
}

/** Field names by the kind of value every record carries for them. */
interface Shapes {
  readonly numeric: readonly string[];
  readonly text: readonly string[];
  readonly temporal: readonly string[];
  /** Group name → member field names that are numeric on every member. */
  readonly groups: ReadonlyMap<string, readonly string[]>;
}

function classify(records: readonly JsonRecord[]): Shapes {
  const names = new Set<string>();
  for (const record of records) for (const key of Object.keys(record)) names.add(key);

  const numeric: string[] = [];
  const text: string[] = [];
  const temporal: string[] = [];
  const groups = new Map<string, readonly string[]>();

  for (const name of names) {
    if (records.every((record) => numberAt(record, name) !== null)) {
      numeric.push(name);
      continue;
    }
    if (records.every((record) => timeAt(record, name) !== null)) {
      temporal.push(name);
      continue;
    }
    if (records.every((record) => stringAt(record, name) !== null)) {
      text.push(name);
      continue;
    }

    const collected = records.map((record) => groupAt(record, name));
    if (!collected.every((group): group is JsonRecord[] => group !== null)) continue;

    const members = collected.flat();
    if (members.length === 0) continue;

    const memberNames = new Set<string>();
    for (const member of members) for (const key of Object.keys(member)) memberNames.add(key);

    groups.set(
      name,
      [...memberNames].filter((member) =>
        members.every((entry) => numberAt(entry, member) !== null),
      ),
    );
  }

  return { numeric, text, temporal, groups };
}

/**
 * The first hypothesis that holds for a numeric field, in a fixed order of preference.
 *
 * A field can satisfy more than one — `total` over a group of one member is simultaneously the
 * sum, the minimum and the maximum — so the order matters and is chosen by how much of the
 * group each rule explains. Sum uses every member, count uses the group's size, and the
 * extremes use one member each.
 */
function numericRule(
  records: readonly JsonRecord[],
  field: string,
  shapes: Shapes,
): DerivedRuleSpec | null {
  const values = records.map((record) => numberAt(record, field));
  if (!values.every((value): value is number => value !== null)) return null;

  for (const [group, memberFields] of shapes.groups) {
    if (group === field) continue;
    const groupsPerRecord = records.map((record) => groupAt(record, group));
    if (!groupsPerRecord.every((entry): entry is JsonRecord[] => entry !== null)) continue;

    for (const member of memberFields) {
      const totals = groupsPerRecord.map((entries) =>
        entries.reduce((sum, entry) => sum + (numberAt(entry, member) ?? 0), 0),
      );
      if (values.every((value, index) => close(value, totals[index] ?? Number.NaN))) {
        return { kind: 'sum', overField: group, ofField: member };
      }
    }

    if (values.every((value, index) => value === (groupsPerRecord[index]?.length ?? -1))) {
      return { kind: 'count', overField: group };
    }

    for (const member of memberFields) {
      const extremes = groupsPerRecord.map((entries) =>
        entries.map((entry) => numberAt(entry, member) ?? Number.NaN),
      );
      if (extremes.some((entry) => entry.length === 0)) continue;

      if (values.every((value, index) => close(value, Math.min(...(extremes[index] ?? [])))))
        return { kind: 'min', overField: group, ofField: member };
      if (values.every((value, index) => close(value, Math.max(...(extremes[index] ?? [])))))
        return { kind: 'max', overField: group, ofField: member };
    }
  }

  return null;
}

/** A date that is another date shifted by a fixed number of whole days. */
function temporalRule(
  records: readonly JsonRecord[],
  field: string,
  shapes: Shapes,
): DerivedRuleSpec | null {
  const values = records.map((record) => timeAt(record, field));
  if (!values.every((value): value is number => value !== null)) return null;

  for (const source of shapes.temporal) {
    if (source === field) continue;
    const sources = records.map((record) => timeAt(record, source));
    if (!sources.every((value): value is number => value !== null)) continue;

    const first: number = (values[0] ?? 0) - (sources[0] ?? 0);
    const offsetDays = first / DAY_MS;
    // Whole days only. An offset of 30.04 days is a coincidence of when two timestamps were
    // written, not a rule the application enforces.
    if (!Number.isInteger(offsetDays)) continue;

    if (values.every((value, index) => value - (sources[index] ?? Number.NaN) === first)) {
      return { kind: 'date_offset', fromField: source, offsetDays };
    }
  }

  return null;
}

/**
 * A string that is two other strings joined by a fixed separator.
 *
 * Ordered pairs only. Arity is capped deliberately: `DerivedRuleSpec` allows one separator for
 * the whole expression, so a three-part concatenation is only expressible when both joins use
 * the same string, and searching for it multiplies the hypothesis space for a case that is
 * mostly `street, city, postcode` — which does not have one separator anyway.
 */
function concatRule(
  records: readonly JsonRecord[],
  field: string,
  shapes: Shapes,
): DerivedRuleSpec | null {
  const values = records.map((record) => stringAt(record, field));
  if (!values.every((value): value is string => value !== null)) return null;
  // A constant column concatenates trivially with anything. Nothing to learn from it.
  if (new Set(values).size < 2) return null;

  const parts = shapes.text.filter((name) => name !== field);

  for (const left of parts) {
    for (const right of parts) {
      if (left === right) continue;
      for (const separator of SEPARATORS) {
        const holds = values.every((value, index) => {
          const record = records[index];
          if (record === undefined) return false;
          return (
            value === `${stringAt(record, left) ?? ''}${separator}${stringAt(record, right) ?? ''}`
          );
        });
        if (holds) return { kind: 'concat', fields: [left, right], separator };
      }
    }
  }

  return null;
}

/** The fields a rule reads. The solver has to evaluate all of them before it can evaluate this. */
function dependenciesOf(rule: DerivedRuleSpec): string[] {
  switch (rule.kind) {
    case 'sum':
    case 'min':
    case 'max':
      return [rule.overField];
    case 'count':
      return [rule.overField];
    case 'date_offset':
      return [rule.fromField];
    case 'concat':
      return [...rule.fields];
  }
}

/**
 * How willingly a rule is given up when it conflicts with another. Lower is kept first.
 *
 * The case this exists for is a pair of dates thirty days apart. `dueAt = createdAt + 30d` and
 * `createdAt = dueAt − 30d` both hold across every record, and both are true — but only one of
 * them is a *rule*, because a solver told to evaluate both has nowhere to start.
 *
 * Nothing in the data says which direction is the real one, so the tie-break is stated as the
 * heuristic it is: a positive offset is preferred, because applications compute due dates,
 * expiry dates and review dates *forward* from an anchor that was recorded first. Where that is
 * wrong, the rule still produces records the application accepts — it has just picked the less
 * natural of two equivalent descriptions.
 */
function preferenceOf(rule: DerivedRuleSpec): number {
  if (rule.kind !== 'date_offset') return 0;
  return rule.offsetDays > 0 ? 1 : 2;
}

/**
 * Drop rules until no field is derived, transitively, from itself.
 *
 * Greedy over a stable ordering: a candidate is kept only if keeping it leaves the dependency
 * graph acyclic. That handles the two-date case and every longer cycle with the same code, and
 * it is deterministic — two crawls of the same application produce the same set.
 */
function breakCycles(candidates: readonly ObservedDerivedRule[]): ObservedDerivedRule[] {
  const ordered = [...candidates].sort((left, right) => {
    const byPreference = preferenceOf(left.rule.rule) - preferenceOf(right.rule.rule);
    return byPreference === 0 ? left.field.localeCompare(right.field) : byPreference;
  });

  const kept = new Map<string, ObservedDerivedRule>();

  const reaches = (from: string, target: string, seen: Set<string>): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);

    const rule = kept.get(from);
    if (rule === undefined) return false;
    return dependenciesOf(rule.rule.rule).some((next) => reaches(next, target, seen));
  };

  for (const candidate of ordered) {
    const cyclic = dependenciesOf(candidate.rule.rule).some((dependency) =>
      reaches(dependency, candidate.field, new Set()),
    );
    if (!cyclic) kept.set(candidate.field, candidate);
  }

  return [...kept.values()];
}

/**
 * Every derived rule that holds across every record of one entity.
 *
 * At most one rule per field, because `FieldSpec.derivedRule` holds one and because a field with
 * two explanations has neither — and no field derived from itself, however indirectly.
 */
export function inferDerivedRules(
  entityName: string,
  records: readonly JsonRecord[],
): ObservedDerivedRule[] {
  if (records.length < MIN_SAMPLE) return [];

  const shapes = classify(records);
  const confidence = Math.min(1, records.length / CONFIDENT_SAMPLE_SIZE);
  const found: ObservedDerivedRule[] = [];

  const consider = (field: string, rule: DerivedRuleSpec | null): void => {
    if (rule === null) return;
    found.push({
      entityName,
      field,
      rule: { rule, confidence, sampleSize: records.length },
    });
  };

  for (const field of shapes.numeric) consider(field, numericRule(records, field, shapes));
  for (const field of shapes.temporal) consider(field, temporalRule(records, field, shapes));
  for (const field of shapes.text) consider(field, concatRule(records, field, shapes));

  return breakCycles(found);
}
