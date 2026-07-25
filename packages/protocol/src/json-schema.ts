import { z } from 'zod';

import { protocolRegistry } from './registry.js';

/**
 * The JSON Schema export.
 *
 * This is the seam that stops TypeScript and Python from drifting: the bundle produced here is
 * written to `dist/schema.json` by `pnpm --filter protocol build`, and
 * `pnpm --filter protocol gen:python` turns it into the pydantic models under
 * `apps/composer/src/composer/protocol/`. Neither side hand-writes the other's shapes.
 *
 * A note on the generator, because docs/BUILD-PLAN.md Phase 1 names a specific library. The
 * `zod-to-json-schema` package reads Zod 3 internals; run against Zod 4 it resolves every
 * definition to an empty `{}` — it does not throw, it silently produces a bundle with no
 * fields in it. Zod 4 ships the conversion natively as `z.toJSONSchema`, which is what is used
 * below. The output is the same draft 2020-12 `$defs` bundle the phase asked for.
 */

/** Canonical identifier of the bundle. Stable: consumers may pin `$ref`s against it. */
export const PROTOCOL_SCHEMA_ID = 'https://wisprtest.dev/schema/protocol.json';

/** JSON Schema dialect the bundle is written in. */
export const PROTOCOL_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** A draft 2020-12 document whose `$defs` hold every registered contract schema. */
export interface JsonSchemaBundle {
  readonly $schema: string;
  readonly $id: string;
  readonly $defs: Readonly<Record<string, unknown>>;
}

/** Scalar types for which `T | null` can be written as a JSON Schema type array. */
const NULLABLE_SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

/**
 * Rewrite `anyOf: [scalar, {type: 'null'}]` — how Zod expresses a nullable scalar — into a
 * single schema with `type: [scalar, 'null']`.
 *
 * Both forms mean exactly the same thing to a validator. The pydantic generator treats them
 * very differently: given the `anyOf` form it cannot attach the scalar's constraints to a
 * nullable field, so it invents a wrapper model named after whichever property it saw first,
 * and the composer ends up writing `entry.reason.root` to read a string. Given the type-array
 * form it emits `str | None` with the constraints inline.
 *
 * A nullable reference to an object or union (`StructuralDiff | None`) already generates cleanly
 * and keeps its reference; a nullable reference to a *scalar* definition is resolved through
 * `defs` and folded the same way, since `NonEmptyString | None` would put the caller back to
 * unwrapping `.root` to read a string.
 */
function foldNullableScalar(node: Record<string, unknown>, defs: Record<string, unknown>): void {
  const branches = node.anyOf;
  if (!Array.isArray(branches) || branches.length !== 2) return;

  const [branch, nullBranch] = branches as [Record<string, unknown>, Record<string, unknown>];
  if (nullBranch.type !== 'null') return;

  const value = resolveScalarRef(branch, defs);
  if (value === undefined) return;

  const valueType = value.type;
  if (typeof valueType !== 'string' || !NULLABLE_SCALAR_TYPES.has(valueType)) return;

  delete node.anyOf;
  Object.assign(node, value, { type: [valueType, 'null'] });
}

/**
 * Return the schema a branch denotes, following a single local `$ref` into `$defs`, or
 * `undefined` if the branch is neither an inline schema nor a reference to a scalar definition.
 */
function resolveScalarRef(
  branch: Record<string, unknown>,
  defs: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const ref = branch.$ref;
  if (ref === undefined) return branch;
  if (typeof ref !== 'string' || !ref.startsWith('#/$defs/')) return undefined;

  const target = defs[ref.slice('#/$defs/'.length)];
  if (typeof target !== 'object' || target === null) return undefined;
  return target as Record<string, unknown>;
}

/** Depth-first walk applying {@link foldNullableScalar} to every object node in the bundle. */
function foldNullableScalars(node: unknown, defs: Record<string, unknown>): void {
  if (Array.isArray(node)) {
    for (const child of node) foldNullableScalars(child, defs);
    return;
  }
  if (typeof node !== 'object' || node === null) return;

  for (const child of Object.values(node)) foldNullableScalars(child, defs);
  foldNullableScalar(node as Record<string, unknown>, defs);
}

/**
 * Convert every registered schema into one JSON Schema document.
 *
 * Three shaping decisions, all load-bearing for the generated Python:
 *
 * - Where Zod emits both a `format` and the equivalent `pattern` (`uuid`, `date-time`), the
 *   pattern is dropped. Keeping both makes pydantic apply a string regex to a field it has
 *   already typed as `UUID`/`AwareDatetime`, and the redundant multi-hundred-character
 *   date-time regex is the single ugliest thing that would otherwise land in the contract.
 * - Per-definition `$schema` and `$id` keys are stripped. They are correct in isolation but
 *   meaningless once the definitions are nested under one document, and the generator treats a
 *   nested `$id` as a resolution scope.
 * - Nullable scalars are folded from `anyOf` into a type array — see {@link foldNullableScalar}.
 *   This runs as a second pass over the assembled document rather than inside the conversion,
 *   because folding a nullable `$ref` needs the definition it points at.
 *
 * Definitions are emitted in sorted order so the bundle is byte-stable across runs and a
 * contract change shows up as a readable diff.
 */
export function toJsonSchemaBundle(): JsonSchemaBundle {
  const { schemas } = z.toJSONSchema(protocolRegistry, {
    uri: (id) => `#/$defs/${id}`,
    override: (context) => {
      const node: Record<string, unknown> = context.jsonSchema;
      if (typeof node.format === 'string' && typeof node.pattern === 'string') {
        delete node.pattern;
      }
    },
  });

  const defs: Record<string, unknown> = {};
  for (const id of Object.keys(schemas).sort()) {
    const { $schema: _dialect, $id: _id, ...definition } = schemas[id] ?? {};
    defs[id] = definition;
  }
  foldNullableScalars(defs, defs);

  return { $schema: PROTOCOL_SCHEMA_DIALECT, $id: PROTOCOL_SCHEMA_ID, $defs: defs };
}
