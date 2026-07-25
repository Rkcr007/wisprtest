import { z } from 'zod';

/**
 * The protocol registry.
 *
 * Every schema that appears as a named definition in the exported JSON Schema bundle — and
 * therefore as a named pydantic model in `apps/composer` — is registered here through
 * {@link contract}. Registration is what makes a schema part of the published contract:
 * anything not registered is inlined at its use site.
 *
 * Primitives (`Sha256Hex`, `Confidence`, `ElementKey`, …) are deliberately *not* registered.
 * A registered scalar becomes a `RootModel[str]` on the Python side, which would force every
 * consumer to unwrap `.root` to read a hash. Inlined, they arrive as a plain constrained
 * `str` with the pattern intact, which is what the composer actually wants.
 *
 * Members of a discriminated union are also not registered. They carry a `title` via
 * `.meta({ title })` instead, which the pydantic generator turns into a properly named class
 * without adding a `$ref` indirection the TypeScript side would never use.
 */
export interface ContractMeta {
  /** Name of the definition in `$defs`, and of the generated pydantic class. */
  readonly id: string;
}

export const protocolRegistry = z.registry<ContractMeta>();

const schemasById = new Map<string, z.ZodType>();

/**
 * Register `schema` as a named part of the contract and return it unchanged.
 *
 * Ids must be unique and must be valid Python class names, because that is what they become.
 */
export function contract<T extends z.ZodType>(id: string, schema: T): T {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(id)) {
    throw new Error(`protocol schema id must be PascalCase and alphanumeric: ${id}`);
  }
  if (schemasById.has(id)) {
    throw new Error(`duplicate protocol schema id: ${id}`);
  }
  schemasById.set(id, schema);
  protocolRegistry.add(schema, { id });
  return schema;
}

/**
 * Every registered schema, keyed by id.
 *
 * Populated as the domain modules are evaluated, so read it only after importing the package
 * entrypoint. The fixture completeness test uses it to prove no schema ships untested.
 */
export function protocolSchemas(): ReadonlyMap<string, z.ZodType> {
  return schemasById;
}
