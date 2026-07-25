import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FIXTURES } from './fixtures.js';
import { PROTOCOL_SCHEMA_DIALECT, PROTOCOL_SCHEMA_ID, toJsonSchemaBundle } from './json-schema.js';
import { protocolSchemas } from './registry.js';

/**
 * The contract's own test suite.
 *
 * Three properties are asserted here, and between them they are what stop this package from
 * quietly rotting:
 *
 * 1. **Completeness** — every registered schema has fixtures, and every fixture names a
 *    registered schema. A shape cannot ship untested, and a deleted shape cannot leave a
 *    fixture behind.
 * 2. **Round trips** — each valid fixture parses, survives `JSON.stringify`/`JSON.parse`
 *    unchanged, and parses to the same value. This is the property that actually matters for a
 *    wire contract: what one process sends is what the next one gets.
 * 3. **Rejection** — each schema rejects each invalid fixture. A schema that accepts everything
 *    is worse than no schema, because it looks like validation.
 */

const registered = protocolSchemas();

describe('fixture completeness', () => {
  it('has fixtures for every registered schema', () => {
    const missing = [...registered.keys()].filter((id) => !(id in FIXTURES)).sort();
    expect(missing).toEqual([]);
  });

  it('has no fixtures for schemas that are not registered', () => {
    const orphaned = Object.keys(FIXTURES)
      .filter((id) => !registered.has(id))
      .sort();
    expect(orphaned).toEqual([]);
  });

  it('pairs each fixture with the schema it is named for', () => {
    for (const [id, fixture] of Object.entries(FIXTURES)) {
      expect(fixture.schema, `fixture ${id} points at a different schema`).toBe(registered.get(id));
    }
  });
});

describe.each(Object.entries(FIXTURES))('%s', (id, fixture) => {
  it('accepts every valid fixture', () => {
    expect(fixture.valid.length, `${id} has no valid fixture`).toBeGreaterThan(0);

    for (const value of fixture.valid) {
      const result = fixture.schema.safeParse(value);
      expect(result.success, `${id} rejected a valid fixture: ${format(result)}`).toBe(true);
    }
  });

  it('round-trips every valid fixture through JSON unchanged', () => {
    for (const value of fixture.valid) {
      const parsed: unknown = fixture.schema.parse(value);
      const reparsed: unknown = fixture.schema.parse(JSON.parse(JSON.stringify(parsed)));

      // Parsing must be a projection, not a transformation: no defaults are filled in, no
      // values are coerced, nothing is dropped. If this fails, TypeScript and Python have
      // stopped agreeing about what the payload is.
      expect(reparsed).toEqual(parsed);
      expect(parsed).toEqual(value);
    }
  });

  it('rejects every invalid fixture', () => {
    expect(fixture.invalid.length, `${id} has no invalid fixture`).toBeGreaterThan(0);

    for (const { why, value } of fixture.invalid) {
      const result = fixture.schema.safeParse(value);
      expect(result.success, `${id} accepted an invalid fixture (${why})`).toBe(false);
    }
  });
});

describe('discriminated unions', () => {
  const unions = [...registered].filter(
    (entry): entry is [string, z.ZodDiscriminatedUnion] =>
      entry[1] instanceof z.ZodDiscriminatedUnion,
  );

  it('finds the unions to check', () => {
    // A guard against the check above silently matching nothing after a Zod upgrade.
    expect(unions.length).toBeGreaterThan(5);
  });

  it.each(unions)('%s has a valid fixture for every member', (id, union) => {
    const fixture = FIXTURES[id];
    if (fixture === undefined) throw new Error(`no fixture for ${id}`);

    // A union is only really covered when every arm has been exercised. Without this, a union
    // could grow a member that nothing has ever parsed and the suite would stay green. More
    // than one fixture per member is welcome; zero is not.
    const covered = new Set(fixture.valid.map((value) => discriminatorOf(value, union)));
    const uncovered = memberDiscriminators(union).filter((member) => !covered.has(member));
    expect(uncovered).toEqual([]);
  });
});

describe('JSON Schema bundle', () => {
  const bundle = toJsonSchemaBundle();

  it('is a draft 2020-12 document with a stable id', () => {
    expect(bundle.$schema).toBe(PROTOCOL_SCHEMA_DIALECT);
    expect(bundle.$id).toBe(PROTOCOL_SCHEMA_ID);
  });

  it('holds exactly one definition per registered schema', () => {
    expect(Object.keys(bundle.$defs).sort()).toEqual([...registered.keys()].sort());
  });

  it('resolves every internal reference', () => {
    const dangling = [...collectRefs(bundle.$defs)]
      .filter((ref) => !(ref.startsWith('#/$defs/') && ref.slice(8) in bundle.$defs))
      .sort();
    expect(dangling).toEqual([]);
  });

  it('emits definitions in sorted order so regeneration produces a readable diff', () => {
    const ids = Object.keys(bundle.$defs);
    expect(ids).toEqual([...ids].sort());
  });

  it('never carries a redundant pattern alongside a format', () => {
    const offenders: string[] = [];
    walk(bundle.$defs, (node, path) => {
      if (typeof node.format === 'string' && typeof node.pattern === 'string') {
        offenders.push(path);
      }
    });
    expect(offenders).toEqual([]);
  });

  it('expresses nullable scalars as a type array rather than an anyOf', () => {
    // The `anyOf` form makes the pydantic generator wrap the scalar in a model, which is how
    // the composer would end up reading `entry.reason.root` instead of `entry.reason`. Only
    // scalars are affected: a nullable array or a nullable `$ref` already generates cleanly and
    // keeps its `anyOf`.
    const scalars = new Set(['string', 'number', 'integer', 'boolean']);
    const offenders: string[] = [];
    walk(bundle.$defs, (node, path) => {
      const branches = node.anyOf;
      if (!Array.isArray(branches)) return;
      const hasScalar = branches.some(
        (branch) => isRecord(branch) && typeof branch.type === 'string' && scalars.has(branch.type),
      );
      const hasNull = branches.some((branch) => isRecord(branch) && branch.type === 'null');
      if (hasScalar && hasNull) offenders.push(path);
    });
    expect(offenders).toEqual([]);
  });

  it('survives serialisation, since that is how it is published', () => {
    expect(JSON.parse(JSON.stringify(bundle))).toEqual(bundle);
  });
});

function format(result: z.ZodSafeParseResult<unknown>): string {
  return result.success ? '' : JSON.stringify(result.error.issues);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function discriminatorOf(value: unknown, union: z.ZodDiscriminatedUnion): unknown {
  return isRecord(value) ? value[union.def.discriminator] : undefined;
}

/** The discriminator literal declared by each member of a union. */
function memberDiscriminators(union: z.ZodDiscriminatedUnion): unknown[] {
  return union.def.options.map((option) => {
    const shape: unknown = (option as z.ZodObject).shape;
    if (!isRecord(shape)) throw new Error('union member is not an object schema');

    const field = shape[union.def.discriminator];
    if (!(field instanceof z.ZodLiteral)) {
      throw new Error(`discriminator ${union.def.discriminator} is not a literal`);
    }
    return field.value;
  });
}

function walk(
  node: unknown,
  visit: (node: Record<string, unknown>, path: string) => void,
  path = '$',
): void {
  if (Array.isArray(node)) {
    node.forEach((child, index) => {
      walk(child, visit, `${path}[${String(index)}]`);
    });
    return;
  }
  if (!isRecord(node)) return;

  visit(node, path);
  for (const [key, child] of Object.entries(node)) {
    walk(child, visit, `${path}.${key}`);
  }
}

function collectRefs(node: unknown, refs = new Set<string>()): Set<string> {
  walk(node, (record) => {
    const ref = record.$ref;
    if (typeof ref === 'string') refs.add(ref);
  });
  return refs;
}
