/**
 * Deciding whether a string is a timestamp.
 *
 * `Date.parse` cannot answer this. It is specified to fall back to implementation-defined
 * heuristics, and V8's are enthusiastic: `Date.parse('ORD-2001')` returns the first of January
 * 2001, and `Date.parse('PO-3100')` returns a date in the thirty-second century. An order
 * reference and a purchase-order number are therefore both "dates" to any classifier that asks
 * `Date.parse` whether they are.
 *
 * That is not a hypothetical. It silently moves an application's identifier columns into the
 * temporal family, where they acquire a distribution measured in day offsets, become candidates
 * for a `date_offset` rule, and — worst — are removed from the pool of string fields, so the
 * `concat` rule that really did relate them is never found.
 *
 * So the shape is checked first and `Date.parse` is only asked to do arithmetic on a string
 * already known to be ISO 8601.
 */

/** `2026-07-31`. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `2026-07-31T12:00:00.000Z`, and the offset and space-separated forms of the same. */
export const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** True when a string is an ISO date or timestamp — by shape, before any parsing. */
export function isIsoTimestamp(value: string): boolean {
  return ISO_DATE.test(value) || ISO_DATETIME.test(value);
}

/** Epoch milliseconds for an ISO date or timestamp. Null for anything else, whatever V8 thinks. */
export function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !isIsoTimestamp(value)) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
