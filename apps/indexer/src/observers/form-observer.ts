import type { FieldType, FieldValueConstraints } from 'protocol';

import type { CollectedControl, CollectedFormRegion } from '../crawl/collected.js';
import { componentSegment, screenSegment, slugify } from '../crawl/element-key.js';
import { entityNameFromPath, isIdentifierLike, parseGroupedName } from './naming.js';
import { MAX_VOCABULARY_SIZE, sanitizeVocabulary } from './pii.js';
import type { ObservedForm, ObservedFormField } from './types.js';

/**
 * The form observer: an application's own account of its entities.
 *
 * docs/TEST-DATA-ENGINE.md § 2.1. A create form declares the field list, the requiredness, the
 * types, the validation and — through its `<select>` elements — the vocabularies, and it does so
 * on a GET. That is the entire shape of an entity for the price of a page load, which is why
 * this is step 1 of § 8's build order and why the UI materializer it yields is the adapter that
 * is "always available".
 *
 * ## What this observer is *not* allowed to conclude
 *
 * It reads what the page declares and stops. A field's distribution, its referential target and
 * its derived rule all come from the network channel, because a form cannot know them — it has
 * no records in front of it. Where the two channels disagree about a field's type,
 * `consolidate.ts` prefers the one with evidence behind it.
 */

/** How an HTML control type maps onto the contract's field types. */
const CONTROL_TYPES: Readonly<Record<string, FieldType>> = {
  text: 'string',
  search: 'string',
  tel: 'string',
  url: 'string',
  email: 'string',
  password: 'string',
  hidden: 'string',
  textarea: 'text',
  number: 'number',
  range: 'number',
  checkbox: 'boolean',
  radio: 'boolean',
  date: 'date',
  month: 'date',
  week: 'date',
  'datetime-local': 'datetime',
  time: 'datetime',
};

/**
 * A control's field type.
 *
 * `currency` is conspicuously absent, and deliberately: HTML has no currency input, and the only
 * ways to guess one are the field's name or its `step` — the first is app vocabulary this code
 * is forbidden to hold and the second is shared with every other two-decimal quantity. An amount
 * is recorded as a `number` with the observed range, which is what the sampler needs anyway.
 */
function typeOf(control: CollectedControl, enumValues: readonly string[] | null): FieldType {
  if (enumValues !== null) return 'enum';
  return CONTROL_TYPES[control.controlType] ?? 'string';
}

function constraintsOf(control: CollectedControl): FieldValueConstraints {
  return {
    min: control.min,
    max: control.max,
    minLength: control.minLength === null ? null : Math.max(0, Math.trunc(control.minLength)),
    maxLength: control.maxLength === null ? null : Math.max(0, Math.trunc(control.maxLength)),
    pattern: control.pattern === null || control.pattern.trim() === '' ? null : control.pattern,
  };
}

/**
 * The vocabulary a closed-set control declares, or null when it does not declare one.
 *
 * Three ways to be null, and each is a different fact about the control:
 *
 * - It is not a `<select>`, so it declares no set at all.
 * - It lists more options than a vocabulary has, so it is a picker over a collection.
 * - Its option values are identifier-shaped, so it is a picker over a collection with few rows —
 *   which is the case cardinality alone would miss, and the one that would otherwise write eight
 *   account numbers into memory as an enum.
 */
function vocabularyOf(control: CollectedControl): string[] | null {
  if (control.controlType !== 'select') return null;
  if (control.optionCount === 0 || control.optionCount > MAX_VOCABULARY_SIZE) return null;
  if (isIdentifierLike(control.options)) return null;
  return sanitizeVocabulary(control.options);
}

/** A control's field name: what the application calls it, or what it labels it. */
function fieldNameOf(control: CollectedControl): string | null {
  if (control.name !== '') return control.name;
  const slug = slugify(control.accessibleName);
  return slug === '' ? null : slug;
}

/**
 * One control, as a field — or as a group and a member of it.
 *
 * A control named `lines[0][amount]` describes a repeatable group, so it contributes two things:
 * the group itself, and the member flattened to `lines.amount`. Only the first index seen
 * contributes, because a form that renders two blank line rows is describing one shape twice.
 */
function fieldsFor(
  control: CollectedControl,
  elementKeys: readonly string[],
  groupsSeen: Set<string>,
  membersSeen: Set<string>,
): ObservedFormField[] {
  const rawName = fieldNameOf(control);
  if (rawName === null) return [];

  const controlElementKey = control.marker === null ? null : (elementKeys[control.marker] ?? null);
  const enumValues = vocabularyOf(control);

  const grouped = parseGroupedName(rawName);
  if (grouped === null) {
    return [
      {
        name: rawName,
        type: typeOf(control, enumValues),
        required: control.required,
        valueConstraints: constraintsOf(control),
        enumValues,
        controlElementKey,
      },
    ];
  }

  const fields: ObservedFormField[] = [];

  if (!groupsSeen.has(grouped.group)) {
    groupsSeen.add(grouped.group);
    fields.push({
      name: grouped.group,
      type: 'group',
      // The group is required when its first member is; a form that demands one line item says
      // so on the controls, not on the fieldset.
      required: control.required,
      valueConstraints: { min: null, max: null, minLength: null, maxLength: null, pattern: null },
      enumValues: null,
      controlElementKey: null,
    });
  }

  const memberName = `${grouped.group}.${grouped.member}`;
  if (!membersSeen.has(memberName)) {
    membersSeen.add(memberName);
    fields.push({
      name: memberName,
      type: typeOf(control, enumValues),
      required: control.required,
      valueConstraints: constraintsOf(control),
      enumValues,
      controlElementKey,
    });
  }

  return fields;
}

/**
 * The component half of a form's id.
 *
 * `screenSegment` and `componentSegment` are reused from the element-key minter rather than
 * reimplemented, so a form's id and the keys of the controls inside it share a prefix:
 * `orders-new.create-order` holds `orders-new.create-order.customer`. That is what lets the UI
 * adapter find the form's controls in memory from the materializer alone.
 */
function formComponent(region: CollectedFormRegion): string {
  const named = slugify(region.accessibleName);
  if (named !== '') return named;

  // An unnamed form still sits somewhere. Falling back to what it posts to keeps the id stable
  // across crawls, which a positional index would not.
  const action = actionPathOf(region.action);
  if (action !== null) {
    const segment = slugify(action.split('/').filter(Boolean).at(-1) ?? '');
    if (segment !== '') return segment;
  }
  return componentSegment([]);
}

/**
 * The path a form submits to, or null when it does not submit anywhere addressable.
 *
 * `form.action` is normally an absolute URL resolved by the DOM, but not always: a form with
 * `action="javascript:…"` or a `<form>` in a document with an exotic base can hand back
 * something `URL` refuses. That is a property of the application under test, not an error in the
 * crawl — and an uncaught throw here would propagate out of the route handler and fail the whole
 * job over one unparseable attribute.
 */
function actionPathOf(action: string): string | null {
  if (action === '') return null;
  try {
    const { pathname, protocol } = new URL(action);
    return protocol === 'http:' || protocol === 'https:' ? pathname : null;
  } catch {
    return null;
  }
}

export interface FormObservationOptions {
  readonly routePattern: string;
  /** Minted element keys, indexed by the marker the collector stamped. */
  readonly elementKeys: readonly string[];
  readonly regions: readonly CollectedFormRegion[];
}

/**
 * Interpret one route's forms.
 *
 * A region with no usable field names yields nothing rather than an entity with no fields — a
 * schema of zero fields is not a small schema, it is a false claim that the entity was
 * understood, and § 7 says confidence too low to compose must refuse by naming what is missing.
 */
export function observeForms(options: FormObservationOptions): ObservedForm[] {
  const screen = screenSegment(options.routePattern);
  const observed: ObservedForm[] = [];
  const componentsUsed = new Map<string, number>();

  for (const region of options.regions) {
    const groupsSeen = new Set<string>();
    const membersSeen = new Set<string>();
    const fields: ObservedFormField[] = [];

    for (const control of region.controls) {
      fields.push(...fieldsFor(control, options.elementKeys, groupsSeen, membersSeen));
    }
    if (fields.length === 0) continue;

    const actionPath = actionPathOf(region.action);

    // The action names the entity when there is one — `/orders/new` posts to `/orders`, and the
    // collection it posts to is what the record will belong to. The route is the fallback.
    const entityName =
      (actionPath === null ? null : entityNameFromPath(actionPath)) ??
      entityNameFromPath(options.routePattern);
    if (entityName === null) continue;

    const component = formComponent(region);
    const seen = componentsUsed.get(component) ?? 0;
    componentsUsed.set(component, seen + 1);

    observed.push({
      entityName,
      formId: seen === 0 ? `${screen}.${component}` : `${screen}.${component}-${String(seen + 1)}`,
      route: options.routePattern,
      actionPath,
      fields,
    });
  }

  return observed;
}
