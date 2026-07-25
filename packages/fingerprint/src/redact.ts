/**
 * The redaction pipeline.
 *
 * CLAUDE.md § "PII rule": Product Memory stores structure, never content. Accessible names are
 * extracted, scrubbed here, and only then persisted or placed in a prompt. This is a
 * procurement blocker, not a nice-to-have — a table of customer names must never reach memory
 * or a model provider.
 *
 * Everything this package returns as text has been through a {@link Redactor}. There is no path
 * that skips it: `computeFingerprint` redacts before hashing and before storing, and the
 * scoring functions compare redacted forms only.
 *
 * A note on what redaction costs. Masking is deliberately *shape-preserving* — an email becomes
 * `[email]`, not nothing — so two names that differed only in their PII still compare equal,
 * and two that differed structurally still compare different. That is what keeps a redacted
 * name useful as a fingerprint signal.
 */

/**
 * Replaces personally identifying content in a string with stable placeholders.
 *
 * Implementations must be pure and deterministic: the same input has to produce the same output
 * on the indexer and in the extension, or a fingerprint computed by one will not match a name
 * read by the other.
 */
export type Redactor = (text: string) => string;

/**
 * The patterns the default redactor masks, in the order they are applied.
 *
 * Order matters. Emails are matched before phone numbers and digit runs, because the local part
 * of an address can look like either. Currency is matched before bare digit runs so that
 * `$1,200.00` becomes `[amount]` rather than `$[number].00`.
 */
const RULES: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  // Email addresses. Deliberately broad on the local part — anything without whitespace or `@`.
  { pattern: /[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[a-z]{2,}/gi, replacement: '[email]' },

  // Currency amounts: a symbol or ISO code, then a number with optional grouping and decimals.
  // Covers `$1,200`, `£99.50`, `€1.234,56`, `USD 42`, and the trailing-symbol forms `1 200 kr`.
  {
    pattern: /(?:[$£€¥₹]|\b(?:USD|EUR|GBP|JPY|INR|CAD|AUD|CHF|SEK|NOK|DKK)\b)\s?\d[\d.,\s]*\d?/gi,
    replacement: '[amount]',
  },
  {
    // The trailing-symbol form. `[\d.,\s]` rather than `[\d.,]` because several of these
    // locales group with a space: `1 200 kr` is one amount, not a `1` and a `200 kr`.
    pattern: /\b\d[\d.,\s]*\s?(?:kr|zł|Kč|CHF|SEK|NOK|DKK|USD|EUR|GBP)\b/g,
    replacement: '[amount]',
  },

  // Phone numbers: an optional country prefix then 7+ digits, allowing spaces, dots, hyphens
  // and one parenthesised group. Matched before the generic digit run so the separators go too.
  {
    pattern: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d(?:[\s.-]?\d){6,14}\b/g,
    replacement: '[phone]',
  },

  // Any remaining run of five or more digits: account numbers, order ids, card fragments,
  // postcodes. Short runs are left alone — "Page 2" and "3 line items" are structure, not data.
  { pattern: /\d{5,}/g, replacement: '[number]' },
];

/** Collapse runs of whitespace and trim, so layout changes do not read as name changes. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The default redactor: masks emails, currency amounts, phone numbers and long digit runs.
 *
 * Not a claim to catch every kind of PII — a person's name in a row label is not detectable by
 * pattern, and this does not try. It is the mechanical floor. `packages/protocol`'s
 * `RedactedText` marks the boundary, and a tenant can supply a stricter {@link Redactor} through
 * `PageContext` where their data demands one.
 */
export function defaultRedactor(text: string): string {
  let result = normalizeWhitespace(text);
  for (const { pattern, replacement } of RULES) {
    // The regexes are global; `replace` resets `lastIndex` itself, but a shared literal would
    // still be stateful across calls if it were ever used with `exec`. Keep to `replace`.
    result = result.replace(pattern, replacement);
  }
  return normalizeWhitespace(result);
}
