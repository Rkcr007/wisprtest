import { entityNameFromPath, normalizeFieldName } from './naming.js';
import type {
  ApiMaterializerCandidate,
  JsonRecord,
  ObservedExchange,
  ObservedForm,
} from './types.js';

/**
 * API materializer candidates: the fast path for creating a record, learned by watching.
 *
 * docs/TEST-DATA-ENGINE.md § 2.2: "A `POST` whose payload keys align with an observed form
 * yields an **API materializer** — far faster and more reliable than driving the UI." The
 * alignment test is what makes that safe. Applications post constantly — telemetry, search,
 * session refresh — and treating any of them as a create endpoint would produce a materializer
 * that replays a search query and reports having seeded an order.
 *
 * ## Alignment, and why it is measured against the form
 *
 * The denominator is the *form's* field count, not the payload's. A create form is the
 * application's own statement of what an entity needs; a payload that accounts for most of it is
 * plausibly the same operation. Measuring the other way round would let a two-key payload score
 * perfectly against a nine-field form.
 *
 * Names are compared after normalisation, because the form says `poNumber` and the API says
 * `po_number` and they are the same field.
 *
 * ## Every candidate is unverified
 *
 * `verifiedAt` is null on everything this module produces, and the contract is explicit that
 * "such a materializer may not run ahead of the UI adapter". Nothing here has proved that
 * replaying the request creates a record — the crawl is forbidden from finding out. Proving it
 * is the verification step in a later phase; until then the fallback chain runs the UI adapter,
 * which is slower and always correct.
 */

/** Below this share of the form's fields, a payload is a different operation that shares nouns. */
const MIN_ALIGNMENT = 0.6;

/** However well it scores, one or two shared keys is a coincidence. */
const MIN_MATCHED_KEYS = 3;

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The observed payload with every value replaced by the slot that will fill it.
 *
 * Two jobs at once. The obvious one is that the solver needs somewhere to put composed values.
 * The other is PII: the payload observed during a crawl is real data from whatever the
 * application happened to send, and `materializers.spec` is a stored column. Templating is what
 * makes storing the *shape* of a create request safe.
 *
 * An array collapses to a single templated element: a repeatable group's members all take the
 * same shape, and the composed record decides how many there are.
 */
function templatize(value: unknown, path: string): unknown {
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return first === undefined ? [] : [templatize(first, `${path}[]`)];
  }

  if (isRecord(value)) {
    const templated: JsonRecord = {};
    for (const [key, nested] of Object.entries(value)) {
      templated[key] = templatize(nested, path === '' ? key : `${path}.${key}`);
    }
    return templated;
  }

  return `{{${path}}}`;
}

/** Top-level payload keys, normalised for comparison against a form's fields. */
function payloadKeys(body: unknown): Set<string> {
  if (!isRecord(body)) return new Set();
  return new Set(Object.keys(body).map((key) => normalizeFieldName(key)));
}

/**
 * The read-back request that would prove a create worked.
 *
 * A detail read of the same entity — a GET whose route pattern ends in a placeholder. Null when
 * the crawl never saw one, which is honest: the materializer can still run, it simply cannot
 * verify itself, and § 4 makes verification a precondition for running ahead of the UI adapter.
 */
function readBackPathFor(
  entityName: string,
  exchanges: readonly ObservedExchange[],
): string | null {
  for (const exchange of exchanges) {
    if (exchange.method !== 'GET') continue;
    if (exchange.status < 200 || exchange.status >= 300) continue;
    if (!exchange.routePattern.endsWith(':id')) continue;
    if (entityNameFromPath(exchange.path) !== entityName) continue;
    return exchange.routePattern;
  }
  return null;
}

/**
 * Match observed write requests against observed forms.
 *
 * At most one candidate per entity: the best-aligned write wins, and ties are broken by
 * preferring `POST`, which is what creates things.
 */
export function inferApiMaterializers(
  exchanges: readonly ObservedExchange[],
  forms: readonly ObservedForm[],
): ApiMaterializerCandidate[] {
  const best = new Map<string, ApiMaterializerCandidate>();

  for (const exchange of exchanges) {
    if (!WRITE_METHODS.has(exchange.method)) continue;
    if (exchange.status < 200 || exchange.status >= 300) continue;
    if (!isRecord(exchange.requestBody)) continue;

    const keys = payloadKeys(exchange.requestBody);
    if (keys.size === 0) continue;

    for (const form of forms) {
      // Top-level fields only. A group's members are described by the group, and counting
      // `lines.sku` separately would let one repeatable group outvote every other field.
      const formFields = form.fields
        .map((field) => field.name)
        .filter((name) => !name.includes('.'));
      if (formFields.length === 0) continue;

      const normalized = new Set(formFields.map((name) => normalizeFieldName(name)));
      let matched = 0;
      for (const name of normalized) if (keys.has(name)) matched += 1;

      const alignment = matched / normalized.size;
      if (matched < MIN_MATCHED_KEYS || alignment < MIN_ALIGNMENT) continue;

      const candidate: ApiMaterializerCandidate = {
        entityName: form.entityName,
        spec: {
          kind: 'api',
          method: exchange.method as 'POST' | 'PUT' | 'PATCH',
          path: exchange.path,
          payloadTemplate: templatize(exchange.requestBody, ''),
          auth: exchange.auth,
          readBackPath: readBackPathFor(form.entityName, exchanges),
        },
        alignment: Math.round(alignment * 10_000) / 10_000,
      };

      const incumbent = best.get(form.entityName);
      if (incumbent === undefined) {
        best.set(form.entityName, candidate);
        continue;
      }
      if (candidate.alignment > incumbent.alignment) {
        best.set(form.entityName, candidate);
        continue;
      }
      if (
        candidate.alignment === incumbent.alignment &&
        candidate.spec.method === 'POST' &&
        incumbent.spec.method !== 'POST'
      ) {
        best.set(form.entityName, candidate);
      }
    }
  }

  return [...best.values()];
}
