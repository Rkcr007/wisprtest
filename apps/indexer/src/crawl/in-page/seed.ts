import {
  defaultRedactor,
  interactiveCandidates,
  isVisible,
  scoreCandidate,
  type Rect,
} from 'fingerprint';

import type {
  LocatedControl,
  MissingControl,
  RecordControlLocation,
  RecordControlOptions,
  SeedControlKind,
  SeedLocateOptions,
  SeedLocateResult,
  SubmitLocation,
} from '../../seed/located.js';

/**
 * Finding a form's controls again, in the page, at materialization time.
 *
 * The UI adapter is "the runtime executor pointed at a form" (docs/TEST-DATA-ENGINE.md § 4), and
 * this is the part that makes that literally true: identity comes from `scoreCandidate` in
 * `packages/fingerprint`, the same function the extension's resolver scores integrity with, over
 * the same stored fingerprints. CLAUDE.md rule #4 — a selector reconstructed here would drift from
 * the resolver, and the adapter would start failing on exactly the forms the runtime handles fine.
 *
 * ## Why this is not `resolve()`
 *
 * `resolve()` answers "which of these did the tester mean", and it is deliberately unwilling to
 * pick when two candidates are close. That is the wrong question here. The plan already names the
 * control — the schema recorded its element key when the form was observed — so the only question
 * is whether *that* control is still on the page. Affinity to a spoken phrase does not enter into
 * it, and there is nothing for a tester to disambiguate between at materialization time anyway.
 *
 * So this scores integrity alone and takes the best match above a floor. It is the same scoring
 * function, asked the narrower question.
 *
 * ## One element per field
 *
 * A control already claimed by an earlier field is not offered to a later one. Two schema fields
 * matching the same live element means the page is not the form memory recorded — filling it
 * twice would put the second field's value in the first field's box and submit it without
 * complaint.
 */

/** Bounded by the seed's own attribute so a locate pass cannot disturb the crawl's markers. */
function measureAll(candidates: readonly Element[]): Map<Element, Rect> {
  const rects = new Map<Element, Rect>();
  for (const element of candidates) {
    const box = element.getBoundingClientRect();
    rects.set(element, { x: box.x, y: box.y, width: box.width, height: box.height });
  }
  return rects;
}

/** How this control has to be driven, read from the live element rather than from the schema. */
function controlKind(element: Element): SeedControlKind {
  const tag = element.tagName.toLowerCase();
  if (tag === 'select') return 'select';
  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'file') return 'file';
  }
  return 'editable';
}

/**
 * Whether the adapter can actually put a value into this control.
 *
 * Reported rather than filtered: a disabled required field is a specific, actionable failure —
 * the form expects something to be chosen before that control becomes writable — and dropping it
 * from the located set would surface as the vaguer "control not found".
 */
function isWritable(element: Element): boolean {
  if (element.hasAttribute('disabled')) return false;
  if (element.getAttribute('aria-disabled') === 'true') return false;
  if (element.hasAttribute('readonly')) return false;
  return true;
}

/**
 * Locate every control the plan needs to fill, stamping each with a marker.
 *
 * Runs one scoring pass per target over the visible interactive elements. A form is dozens of
 * controls, not thousands, so the quadratic shape costs nothing measurable and keeps the
 * "best match wins, claimed elements are excluded" rule easy to read.
 */
export function locateControls(options: SeedLocateOptions): SeedLocateResult {
  const candidates = [...interactiveCandidates(document.body)];
  const rects = measureAll(candidates);
  const measure = (element: Element): Rect =>
    rects.get(element) ?? { x: 0, y: 0, width: 0, height: 0 };

  const visible = candidates.filter((element) => isVisible(element, measure(element)));

  const claimed = new Set<Element>();
  const located: LocatedControl[] = [];
  const missing: MissingControl[] = [];
  let marker = 0;

  for (const target of options.targets) {
    let best: Element | null = null;
    let bestScore = 0;

    for (const element of visible) {
      if (claimed.has(element)) continue;
      const score = scoreCandidate(target.fingerprint, element, {
        viewport: options.viewport,
        measure,
        redact: defaultRedactor,
      });
      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    }

    if (best === null || bestScore < options.threshold) {
      missing.push({ field: target.field, elementKey: target.elementKey, bestScore });
      continue;
    }

    claimed.add(best);
    best.setAttribute(options.markerAttribute, String(marker));
    located.push({
      field: target.field,
      elementKey: target.elementKey,
      marker,
      kind: controlKind(best),
      score: bestScore,
      writable: isWritable(best),
    });
    marker += 1;
  }

  return { located, missing };
}

/**
 * Find the control that submits the form the located inputs belong to.
 *
 * Not part of the schema, and deliberately so. The form observer records the fields an entity
 * has; which button posts them is a property of the page at the moment of writing, and the HTML
 * specification already answers it — `form.elements` plus the `form=` attribute covers both the
 * button inside the form and the one rendered outside it in a sticky footer.
 *
 * The form is found from a control the locate pass already stamped rather than from the form's
 * indexed id: if the controls were found, their form is the form, and asking twice invites the
 * two answers to disagree.
 */
export function locateSubmit(options: {
  readonly markerAttribute: string;
  readonly anchorMarker: number;
  readonly submitMarker: number;
}): SubmitLocation {
  const anchor = document.querySelector(
    `[${options.markerAttribute}="${String(options.anchorMarker)}"]`,
  );
  if (anchor === null) {
    return { marker: null, reason: 'the control used to find the form is no longer in the page' };
  }

  const form = anchor.closest('form');
  if (form === null) {
    return {
      marker: null,
      reason: 'the create controls are not inside a <form>, so there is nothing to submit',
    };
  }

  const scoped = [
    ...form.querySelectorAll('button, input[type="submit"], input[type="image"]'),
    ...(form.id === ''
      ? []
      : document.querySelectorAll(
          `button[form="${CSS.escape(form.id)}"], input[form="${CSS.escape(form.id)}"]`,
        )),
  ];

  for (const element of scoped) {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') ?? '').toLowerCase();

    // A <button> with no type submits, which is the case authors forget; an explicit `button` or
    // `reset` does not. `image` submits like `submit` does.
    const submits =
      tag === 'button' ? type === '' || type === 'submit' : type === 'submit' || type === 'image';
    if (!submits) continue;
    if (element.hasAttribute('disabled')) continue;

    element.setAttribute(options.markerAttribute, String(options.submitMarker));
    return { marker: options.submitMarker, reason: null };
  }

  return { marker: null, reason: 'the form declares no enabled submit control' };
}

/**
 * Find *this record's* copy of a control that the page repeats once per record.
 *
 * An indexed delete control is as often a button on a list row as a button on a detail page. On a
 * list, every row has one, and they are identical in every respect the fingerprint measures —
 * same role, same accessible name, same landmark path, near-identical geometry. Taking the best
 * scoring one would delete whichever row scored highest, which is arbitrary, and deleting the
 * wrong record is the worst outcome the seeding path can produce.
 *
 * So the record is identified structurally, by the link to it. The row for order 4903 is the
 * element that contains an anchor to `/orders/4903`, and the delete button for order 4903 is the
 * matching control inside that element. This uses the page's own markup rather than its text: it
 * does not read any record's content, and it works the same on a table, a list or a card grid,
 * none of which this code has to know about.
 *
 * The *closest* qualifying ancestor wins, so a candidate in a row scores over one in the table
 * that contains the row. A tie at the same distance is reported as an ambiguity rather than
 * resolved: two delete buttons equally close to the same link is a page this code does not
 * understand, and guessing is not available.
 *
 * When the page *is* the record — a detail route the worker navigated to — there may be no link to
 * it at all, and there does not need to be: everything on the page belongs to the record, so a
 * single match is unambiguous on its own.
 */
export function locateRecordControl(options: RecordControlOptions): RecordControlLocation {
  const candidates = [...interactiveCandidates(document.body)];
  const rects = new Map<Element, Rect>();
  for (const element of candidates) {
    const box = element.getBoundingClientRect();
    rects.set(element, { x: box.x, y: box.y, width: box.width, height: box.height });
  }
  const measure = (element: Element): Rect =>
    rects.get(element) ?? { x: 0, y: 0, width: 0, height: 0 };

  const matched: Element[] = [];
  for (const element of candidates) {
    if (!isVisible(element, measure(element))) continue;
    const score = scoreCandidate(options.target.fingerprint, element, {
      viewport: options.viewport,
      measure,
      redact: defaultRedactor,
    });
    if (score >= options.threshold) matched.push(element);
  }

  if (matched.length === 0) {
    return { marker: null, matched: 0, reason: null };
  }

  const stamp = (element: Element): RecordControlLocation => {
    element.setAttribute(options.markerAttribute, String(options.marker));
    return { marker: options.marker, matched: matched.length, reason: null };
  };

  // The page is the record: nothing on it belongs to another one.
  if (matched.length === 1 && document.location.pathname === options.detailPath) {
    const only = matched[0];
    if (only !== undefined) return stamp(only);
  }

  const scoped = matched
    .map((element) => ({ element, distance: distanceToRecord(element, options.detailPath) }))
    .filter((entry) => entry.distance !== null)
    .sort((left, right) => (left.distance ?? 0) - (right.distance ?? 0));

  const [closest, runnerUp] = scoped;
  if (closest === undefined) {
    // A single match with no link to the record is still unambiguous — there is only one control
    // it could be. More than one, with nothing to tell them apart, is not.
    const only = matched[0];
    if (matched.length === 1 && only !== undefined) return stamp(only);
    return {
      marker: null,
      matched: matched.length,
      reason: `${String(matched.length)} controls match, and none of them sits with a link to ${options.detailPath}`,
    };
  }

  if (runnerUp?.distance === closest.distance) {
    return {
      marker: null,
      matched: matched.length,
      reason: `two controls are equally close to the link to ${options.detailPath}`,
    };
  }

  return stamp(closest.element);
}

/**
 * How many ancestors up from `element` the record's own container is, or null if there is none.
 *
 * "Contains a link to the record" is the test, and the walk stops at the body: an ancestor that
 * covers the whole page contains every record's link and identifies nothing.
 */
function distanceToRecord(element: Element, detailPath: string): number | null {
  let current: Element | null = element.parentElement;
  let distance = 1;

  while (current !== null && current !== document.body) {
    for (const anchor of current.querySelectorAll('a[href]')) {
      if ((anchor as HTMLAnchorElement).pathname === detailPath) return distance;
    }
    current = current.parentElement;
    distance += 1;
  }

  return null;
}
