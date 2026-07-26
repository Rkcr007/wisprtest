import { computeAccessibleName } from './accname.js';
import { DEFAULT_CONFIG, type FingerprintConfig } from './config.js';
import { computeLandmarkPath } from './landmarks.js';
import { defaultRedactor, normalizeWhitespace, type Redactor } from './redact.js';
import { computeRole } from './role.js';
import { sha256Hex } from './sha256.js';

/**
 * The three inputs to the state fingerprint, and the fingerprint itself.
 *
 * Two components compute this: the Playwright indexer, when it records a screen, and the
 * extension's RuntimeStateEngine, on every state change. They must agree byte for byte — the
 * state fingerprint is the key a screen is stored under and the key it is looked up by, so a
 * disagreement means the runtime never finds anything the indexer recorded. It is also the
 * *silent* kind of disagreement: memory would look complete, and resolution would simply return
 * nothing, on every command, forever.
 *
 * That is why this lives here rather than in either consumer. See CLAUDE.md rule #4 — the same
 * argument that gives element fingerprinting exactly one implementation.
 *
 * ## PII
 *
 * Dialog labels and landmark names are content: a dialog can perfectly well be titled "Delete
 * account for ada@example.com". Everything read here goes through the redactor before it is
 * returned or hashed, per CLAUDE.md § "PII rule".
 */

/** Dialogs, however the application chose to express one. */
const DIALOG_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

/**
 * `hash(routePattern, modalStack, focusedLandmark)`, per docs/ARCHITECTURE.md § 3.
 *
 * The inputs and their order are fixed by that section. The separator is a space and the modal
 * stack is joined with `|`, so no landmark name can forge a boundary between two fields.
 */
export function computeStateFingerprint(
  routePattern: string,
  modalStack: readonly string[],
  focusedLandmark: string,
): string {
  return sha256Hex([routePattern, modalStack.join('|'), focusedLandmark].join(' '));
}

/**
 * Redacted labels of every open dialog, outermost first.
 *
 * Document order from `querySelectorAll` is outermost-first for nested dialogs, which is the
 * order `RuntimeState.modalStack` is specified in.
 */
export function readModalStack(
  document: Document,
  redact: Redactor = defaultRedactor,
): readonly string[] {
  const stack: string[] = [];
  for (const dialog of document.querySelectorAll(DIALOG_SELECTOR)) {
    const name = normalizeWhitespace(computeAccessibleName(dialog));
    stack.push(name === '' ? computeRole(dialog) : redact(name).toLowerCase());
  }
  return stack;
}

/**
 * The innermost landmark containing the focused element.
 *
 * An empty string when nothing is focused, which is also what the state fingerprint hashes for
 * that case — a page with focus on the body is one state, not an absence of one.
 */
export function readFocusedLandmark(
  document: Document,
  config: FingerprintConfig = DEFAULT_CONFIG,
  redact: Redactor = defaultRedactor,
): string {
  const active = document.activeElement;
  if (active === null || active === document.body) return '';

  return landmarkOf(active, config, redact);
}

/** The innermost landmark containing an element, or an empty string when it is in none. */
export function landmarkOf(
  element: Element,
  config: FingerprintConfig = DEFAULT_CONFIG,
  redact: Redactor = defaultRedactor,
): string {
  return computeLandmarkPath(element, config, redact).at(-1) ?? '';
}

/** The topmost open dialog, or null when none is open. The runtime's reachability scope root. */
export function topmostDialog(document: Document): Element | null {
  const dialogs = document.querySelectorAll(DIALOG_SELECTOR);
  // Document order, so the *last* match is the innermost — a confirmation raised from inside
  // another dialog is the one holding the tester's attention, and the only one they can reach.
  return dialogs.item(dialogs.length - 1);
}
