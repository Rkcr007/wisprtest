import type {
  DerivedRule,
  FieldDistribution,
  FieldType,
  FieldValueConstraints,
  MaterializerSpec,
} from 'protocol';

import { inferApiMaterializers } from './api-materializer.js';
import { collectionsFrom } from './collections.js';
import { inferDerivedRules } from './derived-rules.js';
import { summarizeCollection } from './distributions.js';
import { normalizeFieldName } from './naming.js';
import { inferReferences } from './references.js';
import type {
  ApiMaterializerCandidate,
  FieldStatistics,
  ObservedExchange,
  ObservedForm,
} from './types.js';

/**
 * Consolidation: three channels of observation, one schema per entity.
 *
 * This is `SchemaInference` from docs/TEST-DATA-ENGINE.md § 1 — "consolidate observations into
 * `EntitySchema` + `FieldSpec` with confidence". The observers each see a partial truth and none
 * of them can see the others':
 *
 * | Channel | Knows | Cannot know |
 * |---------|-------|-------------|
 * | Forms | field list, requiredness, validation, declared vocabularies, the UI path | what values are plausible, what points where, what is computed |
 * | Network records | real distributions, real vocabularies, referential edges | which fields are mandatory, what the app will reject |
 * | Derived rules | which fields are computed from which | everything else |
 *
 * Merging them is mostly arithmetic, with one judgement: when the form and the records disagree
 * about a field's type, the more specific answer wins. A form declaring `<input type="text">`
 * over a column of ISO timestamps is describing its widget, not its data.
 *
 * ## Names
 *
 * The same field is `poNumber` on the form and `po_number` in the payload. Fields are merged on
 * the normalised name and stored under the name the *records* use, because that is the name a
 * materializer will have to send and the name a tester will see in a preview.
 */

/** Field types ordered by how much they commit to. The more specific answer wins a disagreement. */
const TYPE_SPECIFICITY: Readonly<Record<FieldType, number>> = {
  string: 0,
  text: 1,
  boolean: 2,
  number: 3,
  integer: 4,
  currency: 5,
  date: 6,
  datetime: 7,
  enum: 8,
  group: 9,
  reference: 10,
};

/** Records at which the sample stops adding to confidence. Matches the derived-rule threshold. */
const CONFIDENT_SAMPLE_SIZE = 50;

/** Priorities from docs/TEST-DATA-ENGINE.md § 4. Fixture 0, API 1, UI 2. */
const API_PRIORITY = 1;
const UI_PRIORITY = 2;

/** How long an API materializer's verification stands before it drops below the UI adapter. */
const VERIFICATION_TTL_HOURS = 168;

/** A `FieldSpec` minus the identifiers the database mints. */
export interface FieldSpecDraft {
  readonly name: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly derivedRule: DerivedRule | null;
  readonly enumValues: readonly string[] | null;
  readonly distribution: FieldDistribution | null;
  readonly referencesEntity: string | null;
  readonly valueConstraints: FieldValueConstraints;
  readonly controlElementKey: string | null;
  readonly unique: boolean;
}

/** A `MaterializerDescriptor` minus the identifiers the database mints. */
export interface MaterializerDraft {
  readonly spec: MaterializerSpec;
  readonly priority: number;
  readonly verifiedAt: string | null;
  readonly verificationTtlHours: number;
}

/** An `EntitySchema` minus the identifiers the database mints. */
export interface EntitySchemaDraft {
  readonly entityName: string;
  readonly observedCount: number;
  readonly confidence: number;
  readonly fields: readonly FieldSpecDraft[];
  readonly materializers: readonly MaterializerDraft[];
}

export interface ConsolidationInput {
  readonly forms: readonly ObservedForm[];
  readonly exchanges: readonly ObservedExchange[];
}

export interface ConsolidationResult {
  readonly schemas: readonly EntitySchemaDraft[];
  /** Recorded for the crawl log: how well each API candidate matched the form it was paired with. */
  readonly apiCandidates: readonly ApiMaterializerCandidate[];
}

const EMPTY_CONSTRAINTS: FieldValueConstraints = {
  min: null,
  max: null,
  minLength: null,
  maxLength: null,
  pattern: null,
};

/** Working state for one field while the channels are being merged into it. */
interface FieldDraft {
  name: string;
  type: FieldType;
  required: boolean;
  derivedRule: DerivedRule | null;
  enumValues: readonly string[] | null;
  distribution: FieldDistribution | null;
  referencesEntity: string | null;
  valueConstraints: FieldValueConstraints;
  controlElementKey: string | null;
  unique: boolean;
  /** True once a form declared this field. Only a form can say whether a field is mandatory. */
  declaredByForm: boolean;
  /** True once records were observed for it. Only records can say what a plausible value is. */
  observedInData: boolean;
}

function moreSpecific(left: FieldType, right: FieldType): FieldType {
  return TYPE_SPECIFICITY[right] > TYPE_SPECIFICITY[left] ? right : left;
}

function emptyDraft(name: string): FieldDraft {
  return {
    name,
    type: 'string',
    required: false,
    derivedRule: null,
    enumValues: null,
    distribution: null,
    referencesEntity: null,
    valueConstraints: EMPTY_CONSTRAINTS,
    controlElementKey: null,
    unique: false,
    declaredByForm: false,
    observedInData: false,
  };
}

/**
 * Confidence in a learned entity.
 *
 * § 7's first failure mode is "schema confidence too low to compose", and this number is what
 * that check reads — so it has to mean something specific rather than being a vibe. It is the
 * weighted answer to four questions an engine needs answered before it can compose a record:
 *
 * | Question | Weight | Answered by |
 * |----------|--------|-------------|
 * | Can a value be produced for each field? | 0.5 | a distribution, a vocabulary, a rule, or a reference |
 * | Is it known which fields are mandatory? | 0.2 | a form, and only a form |
 * | Is there enough data behind the distributions? | 0.2 | the record count |
 * | Is there any way to write the record at all? | 0.1 | a materializer |
 *
 * An entity seen only in a list response scores around 0.7: the engine knows what its records
 * look like and cannot create one. An entity seen only as a form scores lower still, because it
 * can be created but every value would be a guess.
 */
function confidenceOf(
  fields: readonly FieldDraft[],
  observedCount: number,
  materializerCount: number,
): number {
  if (fields.length === 0) return 0;

  const producible = fields.filter(
    (field) =>
      field.distribution !== null ||
      field.enumValues !== null ||
      field.derivedRule !== null ||
      field.referencesEntity !== null,
  ).length;
  const declared = fields.filter((field) => field.declaredByForm).length;

  const score =
    0.5 * (producible / fields.length) +
    0.2 * (declared / fields.length) +
    0.2 * Math.min(1, observedCount / CONFIDENT_SAMPLE_SIZE) +
    0.1 * (materializerCount > 0 ? 1 : 0);

  return Math.round(score * 100) / 100;
}

/** Merge one form's declarations into an entity's fields. */
function applyForm(drafts: Map<string, FieldDraft>, form: ObservedForm): void {
  for (const field of form.fields) {
    const key = normalizeFieldName(field.name);
    const draft = drafts.get(key) ?? emptyDraft(field.name);

    draft.declaredByForm = true;
    draft.type = moreSpecific(draft.type, field.type);
    // Requiredness is a union across forms: a field mandatory on any create path is mandatory.
    draft.required = draft.required || field.required;
    draft.valueConstraints = field.valueConstraints;
    if (field.enumValues !== null && draft.enumValues === null) draft.enumValues = field.enumValues;
    if (field.controlElementKey !== null) draft.controlElementKey = field.controlElementKey;
    // The form's name only stands until the records offer their own.
    if (!draft.observedInData) draft.name = field.name;

    drafts.set(key, draft);
  }
}

/** Merge the statistics of one field of one collection into an entity's fields. */
function applyStatistics(drafts: Map<string, FieldDraft>, statistics: FieldStatistics): void {
  const key = normalizeFieldName(statistics.name);
  const draft = drafts.get(key) ?? emptyDraft(statistics.name);

  draft.observedInData = true;
  // The records name the field. A materializer sends this name and a preview shows it.
  draft.name = statistics.name;
  draft.type = moreSpecific(draft.type, statistics.type);
  draft.distribution = statistics.distribution;
  if (statistics.enumValues !== null) draft.enumValues = statistics.enumValues;
  draft.unique = draft.unique || statistics.unique;

  drafts.set(key, draft);
}

/**
 * Reconcile a field into something the contract and the database will both accept.
 *
 * Two invariants that are checked in Postgres and are easier to hold here than to debug there:
 * a `reference` field names its target and nothing else does, and `enumValues` is populated for
 * `enum` fields and null for every other type.
 *
 * Exported because the same reconciliation is needed wherever two versions of a field spec are
 * combined — notably when a resumed crawl merges what it observed with what its previous attempt
 * already wrote.
 */
export function enforceFieldInvariants(field: FieldSpecDraft): FieldSpecDraft {
  const isReference = field.referencesEntity !== null;
  const type: FieldType = isReference ? 'reference' : field.type;
  const isEnum = !isReference && type === 'enum' && field.enumValues !== null;

  return {
    ...field,
    type,
    enumValues: isEnum ? field.enumValues : null,
    // A reference's "distribution" would be the identifiers of real rows. The solver resolves
    // references against records rather than sampling them, so keeping it would be a list of
    // somebody's primary keys with nothing reading it.
    distribution: isReference ? null : field.distribution,
  };
}

function finalize(draft: FieldDraft): FieldSpecDraft {
  return enforceFieldInvariants({
    name: draft.name,
    type: draft.type,
    required: draft.required,
    derivedRule: draft.derivedRule,
    enumValues: draft.enumValues,
    distribution: draft.distribution,
    referencesEntity: draft.referencesEntity,
    valueConstraints: draft.valueConstraints,
    controlElementKey: draft.controlElementKey,
    unique: draft.unique,
  });
}

/**
 * Combine two observations of the same field, keeping whichever carries evidence.
 *
 * Used when a crawl writes over a field spec that is already there. Every column follows the
 * same principle — an observation that saw something beats one that saw nothing — because the
 * alternative is that the *second* look at an application decides what is known about it, and a
 * resumed crawl looks at less than the run it is continuing.
 */
export function mergeFieldSpecs(
  existing: FieldSpecDraft,
  observed: FieldSpecDraft,
): FieldSpecDraft {
  const constraintsObserved = Object.values(observed.valueConstraints).some(
    (limit) => limit !== null,
  );

  return enforceFieldInvariants({
    name: observed.name,
    type: moreSpecific(existing.type, observed.type),
    // Requiredness is a union, exactly as it is across two forms: a field mandatory on any
    // create path is mandatory, and a run that never saw the form cannot make it optional.
    required: existing.required || observed.required,
    derivedRule: observed.derivedRule ?? existing.derivedRule,
    enumValues: observed.enumValues ?? existing.enumValues,
    distribution: observed.distribution ?? existing.distribution,
    referencesEntity: observed.referencesEntity ?? existing.referencesEntity,
    valueConstraints: constraintsObserved ? observed.valueConstraints : existing.valueConstraints,
    controlElementKey: observed.controlElementKey ?? existing.controlElementKey,
    unique: existing.unique || observed.unique,
  });
}

/**
 * Everything the three observers saw, as schemas.
 *
 * Entities appear here if either channel found them: an entity with a form and no records is
 * creatable but not yet sampleable, and one with records and no form is the reverse. Both are
 * worth storing, and the confidence says which is which.
 */
export function consolidate(input: ConsolidationInput): ConsolidationResult {
  const collections = collectionsFrom(input.exchanges);
  const references = inferReferences(collections);
  const apiCandidates = inferApiMaterializers(input.exchanges, input.forms);

  const entities = new Set<string>([
    ...input.forms.map((form) => form.entityName),
    ...collections.map((collection) => collection.entityName),
  ]);

  const schemas: EntitySchemaDraft[] = [];

  for (const entityName of entities) {
    const drafts = new Map<string, FieldDraft>();

    for (const form of input.forms) {
      if (form.entityName === entityName) applyForm(drafts, form);
    }

    const collection = collections.find((entry) => entry.entityName === entityName);
    const records = collection?.records ?? [];

    for (const statistics of summarizeCollection(records)) applyStatistics(drafts, statistics);

    // References before rules: a reference field is not a candidate for anything else, and the
    // database will reject a row that claims to be both.
    for (const reference of references) {
      if (reference.entityName !== entityName) continue;
      const draft = drafts.get(normalizeFieldName(reference.field));
      if (draft === undefined) continue;
      draft.referencesEntity = reference.referencesEntity;
    }

    for (const derived of inferDerivedRules(entityName, records)) {
      const draft = drafts.get(normalizeFieldName(derived.field));
      if (draft === undefined) continue;
      // A reference is resolved against real records; it is not computed from other fields.
      if (draft.referencesEntity !== null) continue;
      draft.derivedRule = derived.rule;
    }

    const materializers: MaterializerDraft[] = [];

    // The richest form for this entity is the one the UI adapter should drive: a create form
    // declares more fields than the filter that happens to post to the same collection.
    const form = input.forms
      .filter((candidate) => candidate.entityName === entityName)
      .sort((left, right) => right.fields.length - left.fields.length)[0];
    if (form !== undefined) {
      materializers.push({
        spec: { kind: 'ui', form: form.formId, route: form.route },
        priority: UI_PRIORITY,
        // The UI adapter drives the real form, so there is nothing to verify: it exercises the
        // application's own validation by construction. Null here means "no verification is
        // outstanding", and the priority ordering never demotes it.
        verifiedAt: null,
        verificationTtlHours: VERIFICATION_TTL_HOURS,
      });
    }

    const api = apiCandidates.find((candidate) => candidate.entityName === entityName);
    if (api !== undefined) {
      materializers.push({
        spec: api.spec,
        priority: API_PRIORITY,
        // Never verified, and it may not run ahead of the UI adapter until it is. Nothing in a
        // crawl can prove that replaying this request creates a record — proving it means
        // creating one, which the crawl is forbidden from doing.
        verifiedAt: null,
        verificationTtlHours: VERIFICATION_TTL_HOURS,
      });
    }

    const fields = [...drafts.values()];
    if (fields.length === 0) continue;

    schemas.push({
      entityName,
      observedCount: records.length,
      confidence: confidenceOf(fields, records.length, materializers.length),
      fields: fields.map(finalize),
      materializers,
    });
  }

  return {
    schemas: schemas.sort((left, right) => left.entityName.localeCompare(right.entityName)),
    apiCandidates,
  };
}
