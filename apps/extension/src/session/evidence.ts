import { defaultRedactor, type Redactor } from 'fingerprint';
import type { EvidenceRef } from 'protocol';

/**
 * Capturing evidence, and redacting it before it can leave the page.
 *
 * docs/BUILD-PLAN.md Phase 12: "Capture evidence on check actions and on any failure: screenshot
 * of the target region plus a serialised DOM snapshot of the containing landmark. Redact before
 * upload."
 *
 * ## Why only those two moments
 *
 * A `check` is an assertion — its evidence *is* the result — and a failure is the thing a tester
 * will be asked to explain. Capturing on every action would upload a screenshot per click, which
 * costs storage, bandwidth and a great deal of a customer's screen for no question anyone asks.
 *
 * ## Redaction is not optional and not a post-processing step
 *
 * A DOM snapshot of a real application is precisely the thing CLAUDE.md § "PII rule" exists to
 * prevent leaving the browser: a table of customer names, an email in a field, an invoice total.
 * So the serialiser does not capture text and then clean it — it never emits raw text at all.
 * Every text node and every attribute value that could carry content goes through the redactor on
 * the way out, and the structure is what remains. That is also what makes the snapshot useful: the
 * question it answers is "what was on screen and how was it arranged", not "what did it say".
 *
 * The screenshot is the honest exception. Pixels of the target region cannot be redacted
 * meaningfully, which is why it is scoped to the element's own rectangle rather than the viewport,
 * and why capture happens only at the two moments above.
 */

/** Attributes worth keeping: structure and identity, never content. */
const STRUCTURAL_ATTRIBUTES = new Set([
  'role',
  'type',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-expanded',
  'aria-selected',
  'aria-checked',
  'aria-disabled',
  'aria-current',
  'aria-modal',
  'data-testid',
  'name',
  'id',
  'class',
  'disabled',
  'checked',
  'selected',
  'required',
  'readonly',
  'placeholder',
  'href',
  'colspan',
  'rowspan',
]);

/**
 * Attributes whose *value* is content rather than structure, and so is redacted rather than kept.
 *
 * `value` and `placeholder` routinely hold what a tester typed or what the application put in
 * front of them; `href` and `title` routinely hold a record id or a customer name.
 */
const CONTENT_ATTRIBUTES = new Set(['placeholder', 'href', 'title', 'alt', 'value']);

/** Elements whose subtree is never worth serialising, and whose content is often enormous. */
const SKIPPED = new Set(['script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'template']);

/** How deep a snapshot goes. A landmark can contain a whole application; this bounds the cost. */
const MAX_DEPTH = 12;
/** How many children of one node are serialised. A table of 5,000 rows answers no new question. */
const MAX_CHILDREN = 40;

export interface SnapshotOptions {
  readonly redact?: Redactor;
  readonly maxDepth?: number;
  readonly maxChildren?: number;
}

/**
 * The landmark containing an element — the region a snapshot covers.
 *
 * A whole document is too much (and too much of a customer's data); the element alone is too
 * little to explain a failure. The landmark is the unit a tester would point at: "the orders
 * table", "the dialog".
 */
export function containingLandmark(element: Element): Element {
  const landmark = element.closest(
    'main, nav, aside, header, footer, form, section, article, [role="main"], [role="navigation"], [role="dialog"], [role="region"], [role="form"], [role="search"]',
  );
  return landmark ?? element.ownerDocument.body;
}

/**
 * Serialise a subtree to redacted HTML.
 *
 * The output is not the page's markup and is not meant to be re-rendered: it is a structural
 * record with every piece of content already masked. Reconstructing the original from it is
 * impossible by construction, which is the point.
 */
export function serializeRedacted(root: Element, options: SnapshotOptions = {}): string {
  const redact = options.redact ?? defaultRedactor;
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const maxChildren = options.maxChildren ?? MAX_CHILDREN;

  function serializeNode(node: Node, depth: number): string {
    if (node.nodeType === 3 /* Node.TEXT_NODE */) {
      const text = (node.textContent ?? '').trim();
      if (text === '') return '';
      // Redacted, never raw. This is the line that keeps a customer's data in their browser.
      return escapeText(redact(text));
    }

    if (node.nodeType !== 1 /* Node.ELEMENT_NODE */) return '';

    const element = node as Element;
    const tag = element.localName;
    if (SKIPPED.has(tag)) return '';
    if (depth > maxDepth) return `<${tag} data-wispr-truncated="depth"></${tag}>`;

    const attributes: string[] = [];
    for (const attribute of element.attributes) {
      if (!STRUCTURAL_ATTRIBUTES.has(attribute.name)) continue;
      const value = CONTENT_ATTRIBUTES.has(attribute.name)
        ? redact(attribute.value)
        : attribute.value;
      attributes.push(` ${attribute.name}="${escapeAttribute(value)}"`);
    }

    const children = [...element.childNodes];
    const shown = children.slice(0, maxChildren);
    const parts = shown.map((child) => serializeNode(child, depth + 1)).filter((s) => s !== '');
    if (children.length > shown.length) {
      // Said out loud rather than silently cut, so nobody reads a truncated table as a short one.
      parts.push(`<!-- wispr: ${String(children.length - shown.length)} more children omitted -->`);
    }

    return `<${tag}${attributes.join('')}>${parts.join('')}</${tag}>`;
  }

  return serializeNode(root, 0);
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/** The viewport rectangle of an element, for a clipped screenshot. */
export interface CaptureRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The region a screenshot covers: the element, plus a little context around it.
 *
 * Padded because a control photographed edge to edge shows nothing about *why* it failed — the
 * error message beside it is usually the answer. Clamped to the viewport so the capture never
 * asks for pixels that do not exist.
 */
export function captureRegion(
  element: Element,
  view: { width: number; height: number },
  padding = 24,
): CaptureRegion {
  const rect = element.getBoundingClientRect();
  const x = Math.max(0, rect.left - padding);
  const y = Math.max(0, rect.top - padding);
  return {
    x,
    y,
    width: Math.max(1, Math.min(view.width - x, rect.width + padding * 2)),
    height: Math.max(1, Math.min(view.height - y, rect.height + padding * 2)),
  };
}

/** Whether a step is one of the two moments that warrant evidence. */
export function shouldCapture(input: { readonly verb: string; readonly outcome: string }): boolean {
  if (input.verb === 'check') return true;
  return input.outcome === 'failed' || input.outcome === 'rejected';
}

/** SHA-256 of the bytes, hex — the hash the database holds so evidence can be verified later. */
export async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Build the contract's reference for a stored artifact. */
export function evidenceRef(input: {
  readonly kind: EvidenceRef['kind'];
  readonly storageKey: string;
  readonly contentHash: string;
  readonly capturedAt: string;
}): EvidenceRef {
  return {
    kind: input.kind,
    storageKey: input.storageKey,
    contentHash: input.contentHash,
    capturedAt: input.capturedAt,
  };
}
