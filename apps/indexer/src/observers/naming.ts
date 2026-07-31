/**
 * Turning paths and control names into the vocabulary the schema is keyed by.
 *
 * Every rule here is English morphology and URL convention. Nothing in this file knows anything
 * about any customer's application, and nothing in it may ever learn: the moment an entity is
 * named by a lookup table rather than by its path, the engine is a consulting project (CLAUDE.md
 * § "What is generic vs what is per-application").
 */

/** Path segments that name the API rather than the collection, and are skipped when naming. */
const INFRASTRUCTURE_SEGMENTS = new Set(['api', 'rest', 'graphql', 'json', 'data', 'public']);

/** `v1`, `v2`, `2024-06-01` — version markers, not collections. */
const VERSION_SEGMENT = /^(?:v\d+(?:\.\d+)*|\d{4}-\d{2}-\d{2})$/i;

/** A concrete identifier: a number, a UUID, or a route pattern's placeholder. */
const IDENTIFIER_SEGMENT =
  /^(?::.+|\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Z]{2,5}-\d+)$/i;

/** Verbs an application appends to a collection path. `/orders/new` is still about orders. */
const ACTION_SEGMENTS = new Set([
  'new',
  'create',
  'edit',
  'update',
  'delete',
  'search',
  'query',
  'export',
  'import',
  'bulk',
  'preview',
  'validate',
]);

/**
 * Singularise a collection name.
 *
 * Deliberately shallow: the four productive English plural rules and nothing else. An
 * irregular-plural dictionary would be a list of words that grows forever and still misses the
 * customer's domain terms, and getting `Criterion` right is worth less than the name staying
 * predictable — a QA lead reading `Criteria` in the console knows what it refers to.
 */
export function singularize(word: string): string {
  const lower = word.toLowerCase();

  if (lower.length > 4 && lower.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (lower.length > 4 && /(?:s|x|z|ch|sh)es$/.test(lower)) return word.slice(0, -2);
  if (lower.length > 2 && lower.endsWith('s') && !/(?:ss|us|is|as)$/.test(lower)) {
    return word.slice(0, -1);
  }
  return word;
}

/** `line_items` / `line-items` / `lineItems` → `LineItem`. */
export function toEntityName(segment: string): string {
  const words = singularize(segment)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter((word) => word !== '');

  if (words.length === 0) return '';
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join('');
}

/**
 * The entity a path is about.
 *
 * The last segment that names a collection wins: infrastructure prefixes, version markers,
 * concrete identifiers and action verbs are all stepped over. `/api/v2/orders/1841/lines` is
 * about a `Line`; `/orders/new` and `/api/v2/orders?limit=50` are both about an `Order`.
 *
 * Returns null when nothing in the path names a collection — a root path, or one made entirely
 * of identifiers — because guessing an entity name is worse than declining to record one.
 */
export function entityNameFromPath(path: string): string | null {
  const segments = path
    .split('?')[0]
    ?.split('/')
    .filter((segment) => segment !== '');
  if (segments === undefined) return null;

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment === undefined) continue;

    const lower = segment.toLowerCase();
    if (INFRASTRUCTURE_SEGMENTS.has(lower)) continue;
    if (VERSION_SEGMENT.test(segment)) continue;
    if (IDENTIFIER_SEGMENT.test(segment)) continue;
    if (ACTION_SEGMENTS.has(lower)) continue;

    const name = toEntityName(segment);
    if (name !== '') return name;
  }

  return null;
}

/**
 * A field name reduced to the form two channels can be compared on.
 *
 * The same field is `poNumber` on the form, `po_number` in the API payload and `PO_NUMBER` in an
 * export. Comparing them literally would record three fields where there is one, and a schema
 * with a phantom required field refuses to compose. Casing and separators are dropped; a
 * trailing `id` is dropped too, so the form's `account` picker and the payload's `accountId`
 * are recognised as the same reference.
 */
export function normalizeFieldName(name: string): string {
  const flattened = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

  if (flattened.length > 2 && flattened.endsWith('id')) return flattened.slice(0, -2);
  return flattened;
}

/** Shapes a machine-generated identifier takes: a number, a UUID, or a prefixed code. */
const IDENTIFIER_VALUE =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z]{2,6}[-_]\d+)$/i;

/**
 * Whether a set of values is a list of identifiers rather than a vocabulary.
 *
 * The distinction decides what a `<select>` means. `{pending, approved, shipped}` is a
 * vocabulary: the values are words, a tester says them out loud, and the solver can satisfy
 * `status = pending` from them. `{ACC-1001, ACC-1002, …}` is a picker over another collection:
 * the values are keys, they change as rows are added, and freezing them into memory as an enum
 * would have the solver offering a tester a choice of eight account numbers.
 *
 * Shape is the signal, and it is a good one — an application that wanted a human to read the
 * value would not have made it a key.
 */
export function isIdentifierLike(values: readonly string[]): boolean {
  if (values.length === 0) return false;
  return values.every((value) => IDENTIFIER_VALUE.test(value.trim()));
}

/** A parsed `group[0][member]` / `group[0].member` / `group[].member` control name. */
export interface GroupedControlName {
  readonly group: string;
  readonly member: string;
}

/**
 * Split a repeatable group's control name, if it is one.
 *
 * `lines[0][amount]`, `lines[0].amount` and `line_items[][sku]` all describe a member of a
 * repeated group, and every mainstream server framework parses them that way. Recognising the
 * convention is how a repeatable group is found without being told the application has one.
 */
export function parseGroupedName(name: string): GroupedControlName | null {
  const match = /^([A-Za-z_][\w-]*)\[(\d*)\](?:\[([\w-]+)\]|\.([\w-]+))$/.exec(name.trim());
  if (match === null) return null;

  const group = match[1];
  const member = match[3] ?? match[4];
  if (group === undefined || member === undefined || member === '') return null;

  return { group, member };
}
