import { DEFAULT_CONFIG, defaultRedactor, landmarkOf } from 'fingerprint';
import type { FingerprintConfig, Redactor } from 'fingerprint';

/**
 * `focusedLandmark` — the third input to the state fingerprint.
 *
 * ## Why focus is part of the state at all
 *
 * A page with focus inside the filter panel is a different state from the same page with focus
 * in the results table: different controls are reachable by keyboard, and a tester saying "clear
 * it" means different things in each. docs/ARCHITECTURE.md § 3 puts it in the fingerprint for
 * that reason, and `packages/fingerprint` computes the landmark so the indexer and the runtime
 * agree on what it is called.
 *
 * ## Focus events, not a poll
 *
 * `focusin` bubbles and fires *after* `document.activeElement` has moved, so the landmark can be
 * read straight from the event's target. `focusout` fires *before*, which is why it is handled
 * through `relatedTarget` — the element about to receive focus — rather than by reading
 * `activeElement`, which would still name the element being left. A `relatedTarget` of null
 * means focus is returning to the body, and there is no landmark.
 *
 * ## The HUD is not the application
 *
 * When the tester drags the panel or clicks its attach control, `document.activeElement` becomes
 * our shadow host. Treating that as "focus left the application" would change the state
 * fingerprint, invalidate the scoped resolution cache and — through the same key — read as
 * drift, every time somebody touched the HUD. Focus events originating inside the HUD are
 * ignored, and the last landmark the application had stands.
 */

export interface FocusTrackerOptions {
  /** Called when the landmark changes. Not called for a focus move within the same landmark. */
  readonly onChange: (landmark: string) => void;

  /**
   * Focus targets to disregard entirely — the HUD's shadow host.
   *
   * A predicate rather than an element so the content script can pass its own host without this
   * module having to know what a HUD is.
   */
  readonly ignore?: (element: Element) => boolean;

  readonly config?: FingerprintConfig;
  readonly redact?: Redactor;
}

export interface FocusTracker {
  /** The landmark holding focus, or an empty string when focus is on the body or nowhere. */
  readonly landmark: string;
  dispose(): void;
}

export function createFocusTracker(document: Document, options: FocusTrackerOptions): FocusTracker {
  const config = options.config ?? DEFAULT_CONFIG;
  const redact = options.redact ?? defaultRedactor;
  const ignore = options.ignore ?? (() => false);

  // Seeded from wherever focus already is: the engine may well start after the application has
  // autofocused something, and a tracker that assumed the body would report a state the page
  // was never in.
  let landmark = initialLandmark();

  function initialLandmark(): string {
    const active = document.activeElement;
    if (active === null || active === document.body || ignore(active)) return '';
    return landmarkOf(active, config, redact);
  }

  const update = (next: string): void => {
    if (next === landmark) return;
    landmark = next;
    options.onChange(next);
  };

  const onFocusIn = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element) || ignore(target)) return;
    update(target === document.body ? '' : landmarkOf(target, config, redact));
  };

  const onFocusOut = (event: Event): void => {
    const related = (event as FocusEvent).relatedTarget;
    // Something is about to be focused; the `focusin` that follows carries the accurate answer,
    // and acting here would emit a transient empty landmark between the two.
    if (related !== null) return;

    const target = event.target;
    if (target instanceof Element && ignore(target)) return;
    update('');
  };

  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);

  return {
    get landmark(): string {
      return landmark;
    },

    dispose(): void {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
    },
  };
}
