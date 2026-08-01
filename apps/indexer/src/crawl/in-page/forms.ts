import { computeAccessibleName, defaultRedactor, isVisible, type Rect } from 'fingerprint';

import type { CollectedControl, CollectedFormRegion, CollectOptions } from '../collected.js';

/**
 * Form extraction, in the page.
 *
 * The second of the two DOM-touching modules in this service, and a sibling of `collect.ts`
 * because it has the same constraints: it runs inside the application under test, it is bundled
 * by esbuild, and everything it says about an element's *identity* comes from
 * `packages/fingerprint` rather than from its own logic. It adds no notion of what an element is;
 * it reads what the application declares about its own fields.
 *
 * ## Why forms are worth this much trouble
 *
 * A create form is the only place an application states its entity schema in full without being
 * asked. It names every field, says which are mandatory, gives the type of each, publishes the
 * accepted vocabulary of every closed-set field, and declares the validation the record will be
 * held to. docs/TEST-DATA-ENGINE.md § 2.1 calls this "the shape of an entity and the UI path to
 * create one", and it is available from a single GET — no submission, nothing committed.
 *
 * ## What counts as a form
 *
 * `<form>` and `[role="form"]` first. Then *form-like regions*: applications built on component
 * libraries routinely render a dialog full of controls with no `<form>` element anywhere, and an
 * observer that only understood `<form>` would learn nothing from them. An orphan control is
 * attributed to its nearest sectioning ancestor, and such a region is only reported when at
 * least two controls share it — one lone control is a filter box, not an entity.
 *
 * ## PII
 *
 * Nothing leaves here unredacted, and several things never leave at all: no `value`, no
 * `placeholder`, no `textContent`, and no `<option>` *label*. Option **values** are collected
 * because a closed vocabulary is structure and the contract stores it as `enumValues` — but they
 * are redacted, capped, and reported alongside the true count so that a picker listing every
 * account in the business is recognisable as a reference rather than mistaken for an enum.
 */

/** Beyond this many options a control is a picker over a collection, not a vocabulary. */
const MAX_COLLECTED_OPTIONS = 48;

/** Controls with a `type` in this set hold no value worth composing, and are skipped. */
const IGNORED_INPUT_TYPES = new Set(['submit', 'reset', 'button', 'image']);

/** Ancestors that delimit a form-like region, innermost first. */
const REGION_SELECTOR = 'fieldset,section,[role="group"],[role="region"],[role="dialog"],dialog';

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function isFormControl(element: Element): element is FormControl {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  );
}

/**
 * The control's type, normalised.
 *
 * `select` and `textarea` name themselves; an input reports its `type` attribute, defaulting to
 * `text` the way the HTML specification does for an absent or unrecognised value.
 */
function controlTypeOf(element: FormControl): string {
  if (element instanceof HTMLSelectElement) return 'select';
  if (element instanceof HTMLTextAreaElement) return 'textarea';
  const declared = element.getAttribute('type');
  return declared === null || declared.trim() === '' ? 'text' : declared.trim().toLowerCase();
}

/** An attribute read as a finite number, or null. Absent, empty and unparseable all mean null. */
function numericAttribute(element: Element, name: string): number | null {
  const raw = element.getAttribute(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The values a `<select>` will accept.
 *
 * Values rather than labels: the value is what the application submits and stores, and it is the
 * half of an option that belongs to the schema. A label can be a customer's name; a value is
 * `net30`. Both are redacted anyway — the distinction is about which one is *structure*.
 *
 * The empty value that a "Choose one…" placeholder carries is dropped, because it is a prompt
 * rather than a member of the vocabulary.
 */
function optionValues(element: FormControl): { options: string[]; optionCount: number } {
  if (!(element instanceof HTMLSelectElement)) return { options: [], optionCount: 0 };

  const values: string[] = [];
  for (const option of element.options) {
    const value = option.value.trim();
    if (value === '') continue;
    values.push(defaultRedactor(value));
  }

  return { options: values.slice(0, MAX_COLLECTED_OPTIONS), optionCount: values.length };
}

function describeControl(element: FormControl, markerAttribute: string): CollectedControl {
  const marker = element.getAttribute(markerAttribute);
  const { options, optionCount } = optionValues(element);

  return {
    marker: marker === null ? null : Number(marker),
    name: element.getAttribute('name')?.trim() ?? '',
    accessibleName: defaultRedactor(computeAccessibleName(element)),
    controlType: controlTypeOf(element),
    required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
    pattern: element.getAttribute('pattern'),
    min: numericAttribute(element, 'min'),
    max: numericAttribute(element, 'max'),
    minLength: numericAttribute(element, 'minlength'),
    maxLength: numericAttribute(element, 'maxlength'),
    options,
    optionCount,
  };
}

/** The accessible name of a form, falling back to the heading a region is labelled by. */
function regionName(element: Element): string {
  const name = computeAccessibleName(element);
  if (name !== '') return defaultRedactor(name);

  const legend = element.querySelector('legend');
  if (legend?.textContent != null) return defaultRedactor(legend.textContent);

  return '';
}

/**
 * Collect every form and form-like region on the settled page.
 *
 * Exported as a second entry point on the injected bundle; the crawler calls it through
 * `globalThis.__wisprIndexer.collectForms`.
 */
export function collectForms(options: CollectOptions): CollectedFormRegion[] {
  const regions: CollectedFormRegion[] = [];
  const claimed = new Set<Element>();

  const explicit = document.querySelectorAll('form,[role="form"]');
  for (const container of explicit) {
    const controls: CollectedControl[] = [];

    for (const candidate of container.querySelectorAll('input,select,textarea')) {
      if (!isFormControl(candidate)) continue;
      claimed.add(candidate);
      if (IGNORED_INPUT_TYPES.has(controlTypeOf(candidate))) continue;

      const box = candidate.getBoundingClientRect();
      const rect: Rect = { x: box.x, y: box.y, width: box.width, height: box.height };
      // A hidden control is still part of the schema — a CSRF token is not, and neither is the
      // half of a wizard that has not been reached. Visibility is the available distinction.
      if (!isVisible(candidate, rect)) continue;

      controls.push(describeControl(candidate, options.markerAttribute));
    }

    if (controls.length === 0) continue;

    const form = container instanceof HTMLFormElement ? container : null;
    regions.push({
      accessibleName: regionName(container),
      method: (form?.getAttribute('method') ?? 'get').trim().toLowerCase(),
      // `form.action` is resolved against the document base by the DOM; a region that is not a
      // `<form>` posts nowhere this observer can see, and says so with an empty string.
      action: form === null ? '' : form.action,
      controls,
    });
  }

  // Form-like regions: controls that belong to no form, grouped by their nearest sectioning
  // ancestor. Two or more sharing one is a region worth describing.
  const orphans = new Map<Element, CollectedControl[]>();
  for (const candidate of document.querySelectorAll('input,select,textarea')) {
    if (!isFormControl(candidate) || claimed.has(candidate)) continue;
    if (IGNORED_INPUT_TYPES.has(controlTypeOf(candidate))) continue;

    const box = candidate.getBoundingClientRect();
    const rect: Rect = { x: box.x, y: box.y, width: box.width, height: box.height };
    if (!isVisible(candidate, rect)) continue;

    const region = candidate.closest(REGION_SELECTOR);
    if (region === null) continue;

    const existing = orphans.get(region);
    const described = describeControl(candidate, options.markerAttribute);
    if (existing === undefined) orphans.set(region, [described]);
    else existing.push(described);
  }

  for (const [region, controls] of orphans) {
    if (controls.length < 2) continue;
    regions.push({
      accessibleName: regionName(region),
      method: 'get',
      action: '',
      controls,
    });
  }

  return regions;
}
