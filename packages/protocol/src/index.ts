/**
 * `protocol` — the contract.
 *
 * Zod schemas for every payload that crosses a process boundary, with TypeScript types derived
 * via `z.infer` and pydantic v2 models generated from the same JSON Schema export. Nothing else
 * in the repository defines these shapes.
 *
 * ## What is here
 *
 * | Domain     | Schemas |
 * |------------|---------|
 * | Memory     | `ElementFingerprint`, `ElementRecord`, `ScreenNode`, `NavEdge`, `MemoryVersion`, `MemorySnapshot`, `Alias` |
 * | Indexing   | `CrawlJob`, `CrawlBounds`, `AuthProfile`, `SecretRef`, `IndexProgressEvent` |
 * | Auth       | `ExtensionToken`, `ExtensionTokenRequest`, `ExtensionTokenScope` |
 * | Resolution | `ScopedQuery`, `ResolutionResult`, `Tier`, `ResolutionCandidate`, `QueryConstraint` |
 * | Runtime    | `RuntimeState`, `StateFingerprint`, `ActionClass`, `ActionRequest`, `ActionResult`, `SessionStep` |
 * | Data       | `EntitySchema`, `FieldSpec`, `Constraint`, `ConstraintSet`, `CompositionPlan`, `ProvenanceEntry`, `MaterializationResult`, `InverseOperation`, `SeedLedgerEntry` |
 * | Drift      | `DriftReport`, `StructuralDiff` |
 * | Errors     | `WisprError`, `WisprErrorCode`, `Result<T>` |
 *
 * ## How to use it
 *
 * Each name is exported twice: once as a Zod schema and once as the type it infers. That is
 * deliberate — `import { MemorySnapshot } from 'protocol'` gives you the parser in value
 * position and the type in type position, so a consumer never has to invent a second name.
 *
 * ```ts
 * import { MemorySnapshot } from 'protocol';
 *
 * const snapshot: MemorySnapshot = MemorySnapshot.parse(await response.json());
 * ```
 *
 * ## Conventions this package holds to
 *
 * - **Objects are strict.** Every object schema rejects unknown keys, matching the
 *   `extra='forbid'` the pydantic generator emits. A payload that parses on one side and fails
 *   on the other would defeat the point of generating one from the other.
 * - **No defaults.** Nothing here fills in a missing field. A default would make the parsed
 *   value differ from the wire value, and would diverge between the two languages.
 * - **Timestamps are ISO 8601 with an explicit offset**, per CLAUDE.md § "Conventions".
 * - **No content, only structure** — everywhere it is persisted. Accessible names, utterances
 *   and typed text appear as a SHA-256 digest, a redacted display form, or both. Nothing that
 *   is written to memory carries a customer's data.
 *
 *   There is exactly one exception, and it is deliberate: {@link ExistingRecord}, on the
 *   composer's request boundary, carries real records from the application under test. Reference
 *   resolution is impossible without them — "an order for Acme Industrial" needs to know that
 *   Acme Industrial exists. They travel with one request, are never persisted, and never reach a
 *   model provider. See that schema's own documentation.
 *
 * ## What is not here
 *
 * No implementation logic. This package parses and describes; it does not fingerprint,
 * resolve, score, sample or dispatch. `toJsonSchemaBundle` is the one function it exports, and
 * it exists to publish the schemas rather than to act on them.
 */

export * from './primitives.js';
export * from './vocabulary.js';
export * from './memory.js';
export * from './indexing.js';
export * from './auth.js';
export * from './resolution.js';
export * from './runtime.js';
export * from './data.js';
export * from './composition.js';
export * from './drift.js';
export * from './errors.js';
export * from './json-schema.js';
export { protocolRegistry, protocolSchemas } from './registry.js';
export type { ContractMeta } from './registry.js';
