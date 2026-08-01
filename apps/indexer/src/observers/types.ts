import type {
  DerivedRule,
  FieldDistribution,
  FieldType,
  FieldValueConstraints,
  MaterializerSpec,
} from 'protocol';

/**
 * What the three observers produce, before consolidation turns it into a schema.
 *
 * These types are internal to the indexer on purpose. They describe *observations* — one form on
 * one route, one HTTP exchange, one field's statistics — and observations are not a contract:
 * nothing crosses a process boundary until `consolidate.ts` has turned them into the
 * `EntitySchema` / `FieldSpec` / `MaterializerDescriptor` shapes that `packages/protocol` owns.
 */

/** A JSON object as it came off the wire. */
export type JsonRecord = Record<string, unknown>;

/** One field as a form declares it. The application's own statement about its data. */
export interface ObservedFormField {
  /** The control's `name`, or a slug of its label when it has no name. */
  readonly name: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly valueConstraints: FieldValueConstraints;
  /** Values of a closed-set control. Null when the control is not one, or lists too many. */
  readonly enumValues: readonly string[] | null;
  /** The element key of the control that edits this field, for the UI materializer. */
  readonly controlElementKey: string | null;
}

/** One form, interpreted: an entity's shape and the UI path to create one. */
export interface ObservedForm {
  readonly entityName: string;
  /** `screen.component`, e.g. `orders-new.create-order`. The UI materializer's handle. */
  readonly formId: string;
  readonly route: string;
  /** Where the form submits. Used to corroborate an API materializer, never to build one. */
  readonly actionPath: string | null;
  readonly fields: readonly ObservedFormField[];
}

/** One request/response pair, recorded during the crawl. */
export interface ObservedExchange {
  readonly method: string;
  /** Path as requested, without the query string. */
  readonly path: string;
  /** The same path with dynamic segments generalised, e.g. `/api/v2/orders/:id`. */
  readonly routePattern: string;
  readonly status: number;
  /** Parsed JSON request body, or null when there was none or it was not JSON. */
  readonly requestBody: unknown;
  /** Parsed JSON response body, or null. */
  readonly responseBody: unknown;
  /**
   * How the request authenticated, read from its headers.
   *
   * Recorded because a materializer has to replay it, and replaying it means reusing the
   * tester's live session rather than holding a credential — docs/TEST-DATA-ENGINE.md § 4:
   * "WisprTest never stores app credentials." The *value* of the cookie or the bearer token is
   * never read, only the fact that one was present.
   */
  readonly auth: 'session' | 'bearer' | 'none';
}

/** A collection of records of one entity, as extracted from a list response. */
export interface ObservedCollection {
  readonly entityName: string;
  readonly path: string;
  readonly records: readonly JsonRecord[];
}

/** Everything learned about one field from observed records. */
export interface FieldStatistics {
  readonly name: string;
  readonly type: FieldType;
  readonly distribution: FieldDistribution | null;
  readonly enumValues: readonly string[] | null;
  /** Every observed value was distinct, and the field's shape makes that meaningful. */
  readonly unique: boolean;
  /** How many records carried a non-null value for this field. */
  readonly presentCount: number;
}

/** An API materializer candidate, with the evidence that produced it. */
export interface ApiMaterializerCandidate {
  readonly entityName: string;
  readonly spec: Extract<MaterializerSpec, { kind: 'api' }>;
  /** Fraction of the form's fields the payload accounted for. Recorded in the log, not stored. */
  readonly alignment: number;
}

/** A derived rule found for one field of one entity. */
export interface ObservedDerivedRule {
  readonly entityName: string;
  readonly field: string;
  readonly rule: DerivedRule;
}

/** A referential edge, discovered by matching foreign-key-shaped values across collections. */
export interface ObservedReference {
  readonly entityName: string;
  readonly field: string;
  readonly referencesEntity: string;
  /** Fraction of the field's values that were found in the target collection's identifiers. */
  readonly coverage: number;
}
