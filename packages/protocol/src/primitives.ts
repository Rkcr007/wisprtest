import { z } from 'zod';

import { contract } from './registry.js';

/**
 * Scalar building blocks shared across every domain.
 *
 * These are registered like any other contract schema, which is what gives the pydantic
 * generator one stable name per primitive. Without that it invents a wrapper class per *use
 * site* — `NonEmptyString8`, `NonEmptyString28` — numbered by traversal order, so adding an
 * unrelated schema renames all of them and floods the generated file's diff.
 *
 * The `$ref` indirection is then unwound on the way out: a scalar field collapses to the plain
 * annotated type, and a nullable one is folded by `json-schema.ts`. Only array elements keep
 * the named form, which is where it reads best anyway — `list[ElementKey]`.
 */

/** Lowercase hex SHA-256. The one hash encoding the whole system uses. */
export const Sha256Hex = contract(
  'Sha256Hex',
  z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'expected lowercase hex SHA-256')
    .meta({ title: 'Sha256Hex', description: 'Lowercase hexadecimal SHA-256 digest.' }),
);
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/** Every identifier that originates in PostgreSQL. */
export const Uuid = contract(
  'Uuid',
  z.uuid().meta({ title: 'Uuid', description: 'UUID identifier.' }),
);
export type Uuid = z.infer<typeof Uuid>;

/**
 * Timestamps are UTC and ISO 8601 at every boundary, per CLAUDE.md § "Conventions".
 * The offset is required: a bare local timestamp crossing a process boundary is a bug.
 */
export const IsoDateTime = contract(
  'IsoDateTime',
  z.iso.datetime({ offset: true }).meta({
    title: 'IsoDateTime',
    description: 'ISO 8601 timestamp with an explicit UTC offset.',
  }),
);
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** A score in [0, 1]. Resolver confidence, schema confidence, stability, migration rate. */
export const Confidence = contract(
  'Confidence',
  z
    .number()
    .min(0)
    .max(1)
    .meta({ title: 'Confidence', description: 'Score in the closed range [0, 1].' }),
);
export type Confidence = z.infer<typeof Confidence>;

/** Wall-clock duration in milliseconds. Fractional because `performance.now()` is. */
export const LatencyMs = contract(
  'LatencyMs',
  z
    .number()
    .min(0)
    .meta({ title: 'LatencyMs', description: 'Elapsed wall-clock time in milliseconds.' }),
);
export type LatencyMs = z.infer<typeof LatencyMs>;

/** A zero-based position: ordinal within a parent group, step ordinal within a session. */
export const Ordinal = contract(
  'Ordinal',
  z.int().min(0).meta({ title: 'Ordinal', description: 'Zero-based position.' }),
);
export type Ordinal = z.infer<typeof Ordinal>;

/** A count of observed samples. Drives every confidence figure in the data engine. */
export const SampleSize = contract(
  'SampleSize',
  z
    .int()
    .min(0)
    .meta({ title: 'SampleSize', description: 'Number of observations behind a statistic.' }),
);
export type SampleSize = z.infer<typeof SampleSize>;

/**
 * `screen.component.element`, per CLAUDE.md § "Conventions" — e.g. `orders.filter.pending`.
 * Exactly three lowercase segments; nothing looser, because these ids are spoken about in
 * bug reports and pasted into the console.
 */
export const ElementKey = contract(
  'ElementKey',
  z
    .string()
    .regex(
      /^[a-z0-9]+(?:[_-][a-z0-9]+)*(?:\.[a-z0-9]+(?:[_-][a-z0-9]+)*){2}$/,
      'expected screen.component.element',
    )
    .meta({
      title: 'ElementKey',
      description: 'Stable element identifier in the form screen.component.element.',
    }),
);
export type ElementKey = z.infer<typeof ElementKey>;

/** A concrete URL path as observed in the browser, e.g. `/orders/1841`. */
export const RoutePath = contract(
  'RoutePath',
  z
    .string()
    .regex(/^\/[^\s]*$/, 'expected an absolute path')
    .meta({
      title: 'RoutePath',
      description: 'Absolute URL path of the app under test, without origin.',
    }),
);
export type RoutePath = z.infer<typeof RoutePath>;

/** A route with its identifiers generalised, e.g. `/orders/:id`. The screen cache key. */
export const RoutePattern = contract(
  'RoutePattern',
  z
    .string()
    .regex(/^\/[^\s]*$/, 'expected an absolute path pattern')
    .meta({
      title: 'RoutePattern',
      description: 'Route with dynamic segments generalised, e.g. /orders/:id.',
    }),
);
export type RoutePattern = z.infer<typeof RoutePattern>;

/**
 * `hash(routePattern, modalStack, focusedLandmark)` — the cache key for scoped resolution and
 * the key drift detection is measured against. See docs/ARCHITECTURE.md § 3.
 */
export const StateFingerprint = contract(
  'StateFingerprint',
  Sha256Hex.meta({
    title: 'StateFingerprint',
    description:
      'SHA-256 over route pattern, modal stack and focused landmark; identifies a runtime state.',
  }),
);
export type StateFingerprint = z.infer<typeof StateFingerprint>;

/**
 * A SHA-256 over the structure of a DOM subtree, ignoring text content and volatile
 * attributes. Equal hashes mean the layout is unchanged; a mismatch is what raises drift.
 */
export const StructuralHash = contract(
  'StructuralHash',
  Sha256Hex.meta({
    title: 'StructuralHash',
    description: 'SHA-256 over DOM structure, excluding text content and volatile attributes.',
  }),
);
export type StructuralHash = z.infer<typeof StructuralHash>;

/** Human-facing text that has already passed through the redaction pipeline. */
export const RedactedText = contract(
  'RedactedText',
  z.string().meta({
    title: 'RedactedText',
    description: 'Text that has passed PII redaction and is safe to persist or place in a prompt.',
  }),
);
export type RedactedText = z.infer<typeof RedactedText>;

/** A non-empty label, name or identifier with no further structure. */
export const NonEmptyString = contract(
  'NonEmptyString',
  z
    .string()
    .min(1)
    .meta({ title: 'NonEmptyString', description: 'A string with at least one character.' }),
);
export type NonEmptyString = z.infer<typeof NonEmptyString>;

/**
 * An opaque JSON payload the contract does not model: a materialized record body, a composed
 * field value, an adapter-specific blob.
 *
 * `unknown` rather than a recursive `JsonValue` union on purpose. TypeScript consumers must
 * narrow before use, which is what we want, and the pydantic generator emits `Any` — whereas a
 * recursive union generates Python that does not import (verified against
 * datamodel-code-generator 0.71.0, which emits `list["JsonValue" | None]`).
 */
export const JsonPayload = z.unknown().describe('Arbitrary JSON value; not modelled further.');
export type JsonPayload = z.infer<typeof JsonPayload>;
