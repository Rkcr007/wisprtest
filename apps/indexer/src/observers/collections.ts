import { entityNameFromPath } from './naming.js';
import type { JsonRecord, ObservedCollection, ObservedExchange } from './types.js';

/**
 * Finding the records inside a response.
 *
 * An application returns its collections in whatever envelope its framework favours: a bare
 * array, `{ data: [...] }`, `{ items, total }`, `{ results, next }`. All three are conventions of
 * JSON over HTTP rather than facts about any customer's application, which is why recognising
 * them is generic code and why the list below may grow but must never acquire an entry that only
 * one customer uses.
 *
 * When no convention matches, the fallback is structural: exactly one property holding an array
 * of objects is the collection, whatever it is called. Two such properties is an ambiguity this
 * declines to resolve — a response with both `orders` and `accounts` in it is two collections,
 * and picking one at random would attribute one entity's fields to the other.
 */

/** Envelope properties, in the order they are tried. */
const ENVELOPE_KEYS: readonly string[] = [
  'data',
  'items',
  'results',
  'records',
  'rows',
  'content',
  'entries',
  'values',
  'list',
];

/** A response holding more records than this is an export; the head of it is a fair sample. */
const MAX_RECORDS_PER_ENTITY = 1_000;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecordArray(value: unknown): JsonRecord[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every(isRecord) ? value : null;
}

/**
 * The records a response body carries, whether it holds a list or a single entity.
 *
 * A single-record response is worth extracting too: a detail endpoint routinely returns fields a
 * list endpoint omits, and one more record is one more test of every derived rule.
 */
export function extractRecords(body: unknown): JsonRecord[] | null {
  const direct = asRecordArray(body);
  if (direct !== null) return direct;

  if (!isRecord(body)) return null;

  for (const key of ENVELOPE_KEYS) {
    if (!(key in body)) continue;
    const nested = body[key];

    const list = asRecordArray(nested);
    if (list !== null) return list;
    // `{ data: { … } }` — a single entity in the same envelope its collection uses.
    if (isRecord(nested)) return [nested];
  }

  const arrays = Object.values(body).filter((value) => asRecordArray(value) !== null);
  if (arrays.length === 1) return asRecordArray(arrays[0]);

  // A bare object that is plainly one record rather than an envelope: it has fields and none of
  // them is a collection. The priced dry-run response is exactly this shape.
  if (arrays.length === 0 && Object.keys(body).length > 0) return [body];

  return null;
}

/**
 * Group every read response into collections, one per entity.
 *
 * Only successful reads count. A 404 body describes an error, not an order, and inferring a
 * schema from `{ error: 'not found' }` would produce an entity called `Order` with one string
 * field — which is worse than producing nothing, because it looks like knowledge.
 */
export function collectionsFrom(exchanges: readonly ObservedExchange[]): ObservedCollection[] {
  const byEntity = new Map<string, { path: string; records: JsonRecord[]; seen: Set<string> }>();

  for (const exchange of exchanges) {
    if (exchange.method !== 'GET') continue;
    if (exchange.status < 200 || exchange.status >= 300) continue;

    const entityName = entityNameFromPath(exchange.path);
    if (entityName === null) continue;

    const records = extractRecords(exchange.responseBody);
    if (records === null) continue;

    const existing = byEntity.get(entityName) ?? {
      path: exchange.path,
      records: [],
      seen: new Set<string>(),
    };

    for (const record of records) {
      if (existing.records.length >= MAX_RECORDS_PER_ENTITY) break;
      const identity = JSON.stringify(record);
      if (existing.seen.has(identity)) continue;
      existing.seen.add(identity);
      existing.records.push(record);
    }

    byEntity.set(entityName, existing);
  }

  return [...byEntity].map(([entityName, collection]) => ({
    entityName,
    path: collection.path,
    records: collection.records,
  }));
}
