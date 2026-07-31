import { normalizeFieldName, toEntityName } from './naming.js';
import type { JsonRecord, ObservedCollection, ObservedReference } from './types.js';

/**
 * The referential graph, discovered rather than declared.
 *
 * docs/TEST-DATA-ENGINE.md § 2.2: "Response bodies are scanned for entity relationships
 * (`accountId` in an Order payload that matches an `id` in the Account collection) to build the
 * referential graph." Nobody tells the engine that an order belongs to an account. It is read
 * off the fact that every `accountId` an order carries is an `id` some account has.
 *
 * This matters more than it looks. § 3's worked example — "a customer with an overdue invoice" —
 * is only solvable because the solver can walk `Invoice.account → Account` and produce a
 * two-node composition graph in dependency order. Without the edge it composes an invoice
 * pointing at nothing.
 *
 * ## What stops it finding edges that are not there
 *
 * Value containment on its own is a weak signal: a `quantity` of 3 is "contained in" any
 * collection whose ids happen to include 3. Four guards, all of which have to pass:
 *
 * 1. The target's candidate field must be a genuine identifier — distinct on every record.
 * 2. Coverage must be near total. A real foreign key resolves; a coincidence does not.
 * 3. The source cannot have more distinct values than the target has rows.
 * 4. Ties are broken by name. `accountId` naming `Account` is corroboration the values alone
 *    cannot provide, and it is the difference between an edge and a guess.
 */

/** Fraction of a field's values that must resolve in the target before an edge is recorded. */
const MIN_COVERAGE = 0.9;

/** A target with fewer identifiers than this cannot distinguish a key from a coincidence. */
const MIN_TARGET_IDENTIFIERS = 2;

type Scalar = string | number;

function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

/** Scalar values a field carries, in record order, skipping absent ones. */
function scalarValues(records: readonly JsonRecord[], field: string): Scalar[] {
  const values: Scalar[] = [];
  for (const record of records) {
    const value = record[field];
    if (isScalar(value)) values.push(value);
  }
  return values;
}

function fieldNames(records: readonly JsonRecord[]): string[] {
  const names = new Set<string>();
  for (const record of records) for (const key of Object.keys(record)) names.add(key);
  return [...names];
}

/**
 * The fields of a collection that behave like its primary key.
 *
 * Distinct on every record, scalar, and present everywhere. Most collections have exactly one —
 * `id` — but an application that also exposes a human-readable `reference` has two, and either
 * is a legitimate thing for another entity to point at.
 */
function identifierFields(records: readonly JsonRecord[]): Map<string, Set<Scalar>> {
  const identifiers = new Map<string, Set<Scalar>>();

  for (const name of fieldNames(records)) {
    const values = scalarValues(records, name);
    if (values.length !== records.length) continue;

    const distinct = new Set(values);
    if (distinct.size !== values.length || distinct.size < MIN_TARGET_IDENTIFIERS) continue;

    identifiers.set(name, distinct);
  }

  return identifiers;
}

/**
 * Every referential edge supported by the observed collections.
 *
 * One edge per source field: a field that resolves in two collections has an ambiguity the
 * observer cannot settle from data, and the name is what settles it — falling back to the
 * highest coverage, and then to a stable alphabetical order so two crawls of the same
 * application do not disagree.
 */
export function inferReferences(collections: readonly ObservedCollection[]): ObservedReference[] {
  const targets = collections.map((collection) => ({
    entityName: collection.entityName,
    identifiers: identifierFields(collection.records),
  }));

  const references: ObservedReference[] = [];

  for (const source of collections) {
    const ownIdentifiers = identifierFields(source.records);

    for (const field of fieldNames(source.records)) {
      // A collection's own key is not a reference to anything.
      if (ownIdentifiers.has(field)) continue;

      const values = scalarValues(source.records, field);
      if (values.length === 0) continue;

      const distinct = new Set(values);
      const normalizedField = normalizeFieldName(field);

      let best: ObservedReference | null = null;
      let bestNamed = false;

      for (const target of targets) {
        if (target.entityName === source.entityName) continue;

        for (const identifiers of target.identifiers.values()) {
          if (distinct.size > identifiers.size) continue;

          let resolved = 0;
          for (const value of values) if (identifiers.has(value)) resolved += 1;

          const coverage = resolved / values.length;
          if (coverage < MIN_COVERAGE) continue;

          const named = normalizedField === normalizeFieldName(toEntityName(target.entityName));
          const candidate: ObservedReference = {
            entityName: source.entityName,
            field,
            referencesEntity: target.entityName,
            coverage: Math.round(coverage * 10_000) / 10_000,
          };

          if (best === null) {
            best = candidate;
            bestNamed = named;
            continue;
          }
          if (named && !bestNamed) {
            best = candidate;
            bestNamed = true;
            continue;
          }
          if (named === bestNamed && candidate.coverage > best.coverage) best = candidate;
          if (
            named === bestNamed &&
            candidate.coverage === best.coverage &&
            candidate.referencesEntity < best.referencesEntity
          ) {
            best = candidate;
          }
        }
      }

      if (best !== null) references.push(best);
    }
  }

  return references;
}
