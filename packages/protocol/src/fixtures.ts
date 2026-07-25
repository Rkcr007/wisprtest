import * as p from './index.js';

/**
 * Round-trip fixtures — one valid and at least one invalid payload per contract schema.
 *
 * Not part of the published package: `tsconfig.build.json` excludes it, so nothing here is
 * emitted to `dist`. It exists so `contract.test.ts` can assert three things at once — that
 * every registered schema accepts a realistic payload, that parsing survives a trip through
 * `JSON.stringify`/`JSON.parse` unchanged, and that each schema actually rejects something.
 *
 * The completeness test fails the build if a schema is registered without an entry here, which
 * is what stops a shape from shipping untested.
 *
 * Every invalid fixture carries a `why`, because "this object fails" is not a test — "this
 * object fails *because the confidence is above 1*" is.
 */

export interface InvalidFixture {
  /** What makes this payload invalid. Read out in the test name. */
  readonly why: string;
  readonly value: unknown;
}

export interface SchemaFixture {
  readonly schema: import('zod').ZodType;
  readonly valid: readonly unknown[];
  readonly invalid: readonly InvalidFixture[];
}

/* -------------------------------------------------------------------------------------------
 * Shared values. Realistic rather than minimal: a fixture that only just parses tells you very
 * little about whether the schema describes the payload the system will actually send.
 * ---------------------------------------------------------------------------------------- */

const UUID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UUID_B = '9c5b94b1-35ad-49bb-b118-8e8fc24abf80';
const UUID_C = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const UUID_D = 'c56a4180-65aa-42ec-a945-5fd21dec0538';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = '0f'.repeat(32);

const NOW = '2026-07-25T09:30:00.000Z';
const EARLIER = '2026-07-24T17:05:12.000+02:00';

const BBOX = { x: 0.12, y: 0.4, width: 0.18, height: 0.05 };

const FINGERPRINT = {
  role: 'button',
  tagName: 'button',
  accessibleNameHash: HASH_A,
  accessibleNameRedacted: 'Approve',
  landmarkPath: ['main', 'region:orders'],
  stableAttributes: { 'data-testid': 'order-approve' },
  ordinal: 0,
  textShingleHash: HASH_B,
  bbox: BBOX,
};

const ELEMENT_RECORD = {
  id: UUID_A,
  screenId: UUID_B,
  elementKey: 'orders.detail.approve',
  fingerprint: FINGERPRINT,
  confidence: 0.94,
  stability: 0.88,
};

const SCREEN_NODE = {
  id: UUID_B,
  memoryVersionId: UUID_C,
  routePattern: '/orders/:id',
  stateFingerprint: HASH_C,
  label: 'Order detail',
  structuralHash: HASH_A,
  indexedAt: NOW,
};

const NAV_EDGE = {
  id: UUID_D,
  memoryVersionId: UUID_C,
  fromScreenId: UUID_A,
  toScreenId: UUID_B,
  triggerElementId: UUID_A,
  preconditions: [{ kind: 'no_modal_open' }],
  confidence: 0.91,
};

const MEMORY_VERSION = {
  id: UUID_C,
  tenantId: UUID_A,
  applicationId: UUID_B,
  version: 18,
  status: 'active',
  createdAt: NOW,
  approvedBy: UUID_D,
  failureReason: null,
};

const ALIAS = {
  id: UUID_D,
  tenantId: UUID_A,
  memoryVersionId: UUID_C,
  phrase: 'the pending filter',
  elementId: UUID_A,
  stateFingerprint: HASH_C,
  source: 't2_writeback',
  hits: 12,
  createdAt: NOW,
};

const RESOLUTION_CANDIDATE = {
  elementId: UUID_A,
  elementKey: 'orders.filter.pending',
  label: 'Pending',
  confidence: 0.97,
  signalScores: { role: 0.2, accessible_name: 0.25, landmark_path: 0.15 },
};

const SECOND_CANDIDATE = {
  elementId: UUID_B,
  elementKey: 'orders.filter.approved',
  label: 'Approved',
  confidence: 0.41,
  signalScores: { role: 0.2, accessible_name: 0.08 },
};

const SCOPED_QUERY = {
  verb: 'filter',
  targetPhrase: 'only the pending ones',
  constraints: [{ kind: 'within', landmark: 'region:orders' }],
  stateFingerprint: HASH_C,
  candidateElementKeys: ['orders.filter.pending', 'orders.filter.approved'],
};

const RESOLUTION_RESULT = {
  outcome: 'resolved',
  elementId: UUID_A,
  elementKey: 'orders.filter.pending',
  confidence: 0.97,
  tier: 'T0',
  latencyMs: 4.2,
  candidates: [RESOLUTION_CANDIDATE],
};

const EVIDENCE_REF = {
  kind: 'screenshot',
  storageKey: 'tenants/3f2504e0/sessions/9c5b94b1/step-4.png',
  contentHash: HASH_B,
  capturedAt: NOW,
};

const PROVENANCE = [
  {
    field: 'status',
    value: 'Pending approval',
    source: 'requested',
    explanation: 'matched the enum value spoken as "pending"',
    confidence: 0.96,
  },
  {
    field: 'amount',
    value: 46200,
    source: 'derived',
    explanation: 'sum of the three line item amounts',
    confidence: 1,
  },
];

const FIELD_DISTRIBUTION = {
  shape: {
    kind: 'numeric',
    min: 800,
    max: 240000,
    mean: 32000,
    stddev: 18400,
    fit: 'lognormal',
  },
  sampleSize: 128,
  distinctCount: 121,
};

const FIELD_VALUE_CONSTRAINTS = {
  min: 0,
  max: null,
  minLength: null,
  maxLength: 16,
  pattern: null,
};

const FIELD_SPEC = {
  id: UUID_A,
  entitySchemaId: UUID_B,
  name: 'amount',
  type: 'currency',
  required: true,
  derivedRule: {
    rule: { kind: 'sum', overField: 'line_items', ofField: 'amount' },
    confidence: 1,
    sampleSize: 128,
  },
  enumValues: null,
  distribution: FIELD_DISTRIBUTION,
  referencesEntity: null,
  valueConstraints: FIELD_VALUE_CONSTRAINTS,
  controlElementKey: 'orders.create.amount',
  unique: false,
};

const MATERIALIZER_DESCRIPTOR = {
  id: UUID_C,
  entitySchemaId: UUID_B,
  spec: {
    kind: 'api',
    method: 'POST',
    path: '/api/v2/orders',
    payloadTemplate: { accountId: null, lines: [], poNumber: null },
    auth: 'session',
    readBackPath: '/api/v2/orders/{id}',
  },
  priority: 1,
  verifiedAt: NOW,
  verificationTtlHours: 168,
};

const PREDICATE_DEFINITION = {
  name: 'overdue',
  entity: 'Invoice',
  clauses: [
    { field: 'due_date', op: 'lt', operand: { kind: 'now', offsetDays: 0 } },
    { field: 'status', op: 'neq', operand: { kind: 'literal', value: 'Paid' } },
  ],
  source: 'inferred',
  confidence: 0.87,
  sampleSize: 128,
};

const ENTITY_SCHEMA = {
  id: UUID_B,
  memoryVersionId: UUID_C,
  entityName: 'Order',
  fields: [FIELD_SPEC],
  materializers: [MATERIALIZER_DESCRIPTOR],
  predicates: [PREDICATE_DEFINITION],
  observedCount: 128,
  confidence: 0.93,
  createdAt: NOW,
};

const CONSTRAINT_SET = {
  entity: 'Order',
  constraints: [
    { kind: 'equals', field: 'status', value: 'Pending approval' },
    { kind: 'reference', field: 'account', phrase: 'Acme Industrial' },
    { kind: 'cardinality', field: 'line_items', count: 3 },
  ],
  confidence: 0.96,
  unparsedFragments: [],
};

const COMPOSITION_NODE = {
  nodeId: 'order-1',
  entity: 'Order',
  entitySchemaId: UUID_B,
  mode: 'create',
  existingExternalRef: null,
  fields: { status: 'Pending approval', amount: 46200, account: 'ACC-118' },
  provenance: PROVENANCE,
};

const COMPOSITION_PLAN = {
  id: UUID_A,
  tenantId: UUID_B,
  sessionId: UUID_C,
  memoryVersionId: UUID_D,
  rootNodeId: 'order-1',
  nodes: [COMPOSITION_NODE],
  edges: [{ fromNodeId: 'order-1', toNodeId: 'account-1', viaField: 'account' }],
  materializationOrder: ['account-1', 'order-1'],
  constraintSet: CONSTRAINT_SET,
  createdAt: NOW,
};

const INVERSE_OP = { kind: 'api', method: 'DELETE', path: '/api/v2/orders/4903' };

const MATERIALIZED_RECORD = {
  nodeId: 'order-1',
  entity: 'Order',
  externalRef: 'ORD-4903',
  payload: { id: 4903, status: 'Pending approval' },
  inverseOp: INVERSE_OP,
};

const STRUCTURAL_DIFF = {
  added: [
    {
      elementKey: 'orders.filter.archived',
      role: 'button',
      accessibleNameRedacted: 'Archived',
      landmarkPath: ['main', 'region:orders'],
    },
  ],
  removed: [{ elementKey: 'orders.filter.draft', elementId: UUID_A, role: 'button' }],
  moved: [
    {
      elementKey: 'orders.detail.approve',
      elementId: UUID_B,
      fromLandmarkPath: ['main'],
      toLandmarkPath: ['main', 'region:actions'],
      matchConfidence: 0.82,
    },
  ],
  renamed: [
    {
      elementKey: 'orders.filter.pending',
      elementId: UUID_C,
      fromNameHash: HASH_A,
      toNameHash: HASH_B,
      toNameRedacted: 'Awaiting approval',
      matchConfidence: 0.79,
    },
  ],
  schemaChanges: [
    {
      entity: 'Order',
      kind: 'enum_values_changed',
      field: 'status',
      detail: 'status gained the value "Archived"',
    },
  ],
};

/** Build an object with one key removed, for "missing required field" fixtures. */
function without(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = value;
  return rest;
}

/** Build an object with one key replaced, for "wrong value" fixtures. */
function withField(
  value: Record<string, unknown>,
  key: string,
  replacement: unknown,
): Record<string, unknown> {
  return { ...value, [key]: replacement };
}

export const FIXTURES: Readonly<Record<string, SchemaFixture>> = {
  /* ---------------------------------------------------------------------------- primitives */

  Sha256Hex: {
    schema: p.Sha256Hex,
    valid: [HASH_A, HASH_C],
    invalid: [
      { why: 'uppercase hex', value: 'A'.repeat(64) },
      { why: 'too short', value: 'a'.repeat(63) },
      { why: 'not a string', value: 0 },
    ],
  },
  Uuid: {
    schema: p.Uuid,
    valid: [UUID_A, UUID_B],
    invalid: [
      { why: 'not a uuid', value: 'orders-1841' },
      { why: 'uuid missing a group', value: '3f2504e0-4f89-41d3-9a0c' },
    ],
  },
  IsoDateTime: {
    schema: p.IsoDateTime,
    valid: [NOW, EARLIER],
    invalid: [
      { why: 'no offset — a local timestamp on the wire is a bug', value: '2026-07-25T09:30:00' },
      { why: 'a date with no time', value: '2026-07-25' },
    ],
  },
  Confidence: {
    schema: p.Confidence,
    valid: [0, 0.5, 1],
    invalid: [
      { why: 'above 1', value: 1.01 },
      { why: 'negative', value: -0.1 },
    ],
  },
  LatencyMs: {
    schema: p.LatencyMs,
    valid: [0, 12.5],
    invalid: [{ why: 'time cannot elapse backwards', value: -1 }],
  },
  Ordinal: {
    schema: p.Ordinal,
    valid: [0, 41],
    invalid: [
      { why: 'negative position', value: -1 },
      { why: 'fractional position', value: 1.5 },
    ],
  },
  SampleSize: {
    schema: p.SampleSize,
    valid: [0, 128],
    invalid: [{ why: 'negative sample size', value: -1 }],
  },
  ElementKey: {
    schema: p.ElementKey,
    valid: ['orders.filter.pending', 'order-detail.line_items.add'],
    invalid: [
      { why: 'only two segments', value: 'orders.pending' },
      { why: 'four segments', value: 'orders.filter.pending.button' },
      { why: 'uppercase', value: 'Orders.Filter.Pending' },
    ],
  },
  RoutePath: {
    schema: p.RoutePath,
    valid: ['/orders/1841', '/'],
    invalid: [
      { why: 'not absolute', value: 'orders/1841' },
      { why: 'a full URL rather than a path', value: 'https://app.example.com/orders' },
    ],
  },
  RoutePattern: {
    schema: p.RoutePattern,
    valid: ['/orders/:id', '/orders'],
    invalid: [{ why: 'not absolute', value: 'orders/:id' }],
  },
  StateFingerprint: {
    schema: p.StateFingerprint,
    valid: [HASH_C],
    invalid: [{ why: 'not a SHA-256 digest', value: 'orders-list' }],
  },
  StructuralHash: {
    schema: p.StructuralHash,
    valid: [HASH_A],
    invalid: [{ why: 'not a SHA-256 digest', value: '' }],
  },
  RedactedText: {
    schema: p.RedactedText,
    valid: ['Approve', ''],
    invalid: [{ why: 'not a string', value: null }],
  },
  NonEmptyString: {
    schema: p.NonEmptyString,
    valid: ['Order'],
    invalid: [{ why: 'empty', value: '' }],
  },

  /* ---------------------------------------------------------------------------- vocabulary */

  Tier: {
    schema: p.Tier,
    valid: ['T0', 'T1', 'T2'],
    invalid: [{ why: 'there is no T3', value: 'T3' }],
  },
  ActionClass: {
    schema: p.ActionClass,
    valid: ['R', 'C', 'A', 'S'],
    invalid: [
      { why: 'not a class in the reversibility taxonomy', value: 'X' },
      { why: 'lowercase', value: 'r' },
    ],
  },
  ActionVerb: {
    schema: p.ActionVerb,
    valid: ['click', 'type', 'back'],
    invalid: [{ why: 'the runtime cannot drag', value: 'drag' }],
  },

  /* -------------------------------------------------------------------------------- memory */

  NormalizedBBox: {
    schema: p.NormalizedBBox,
    valid: [BBOX],
    invalid: [
      { why: 'x outside the viewport', value: withField(BBOX, 'x', 1.4) },
      { why: 'missing height', value: without(BBOX, 'height') },
    ],
  },
  ElementFingerprint: {
    schema: p.ElementFingerprint,
    valid: [FINGERPRINT],
    invalid: [
      {
        why: 'accessible name stored raw instead of hashed',
        value: withField(FINGERPRINT, 'accessibleNameHash', 'Approve'),
      },
      { why: 'missing landmark path', value: without(FINGERPRINT, 'landmarkPath') },
      {
        why: 'unknown key — a strict schema will not silently drop it',
        value: withField(FINGERPRINT, 'accessibleName', 'Approve'),
      },
    ],
  },
  ElementRecord: {
    schema: p.ElementRecord,
    valid: [ELEMENT_RECORD],
    invalid: [
      {
        why: 'element key is not screen.component.element',
        value: withField(ELEMENT_RECORD, 'elementKey', 'approve'),
      },
      { why: 'stability above 1', value: withField(ELEMENT_RECORD, 'stability', 1.2) },
    ],
  },
  ScreenNode: {
    schema: p.ScreenNode,
    valid: [SCREEN_NODE],
    invalid: [
      {
        why: 'route pattern is not absolute',
        value: withField(SCREEN_NODE, 'routePattern', 'orders/:id'),
      },
      { why: 'label is empty', value: withField(SCREEN_NODE, 'label', '') },
    ],
  },
  NavPrecondition: {
    schema: p.NavPrecondition,
    valid: [
      { kind: 'element_visible', elementKey: 'orders.detail.approve' },
      { kind: 'route_matches', routePattern: '/orders/:id' },
      { kind: 'modal_open', modalLabel: 'Confirm approval' },
      { kind: 'no_modal_open' },
    ],
    invalid: [
      { why: 'unknown precondition kind', value: { kind: 'element_enabled', elementKey: 'a.b.c' } },
      { why: 'element_visible without an element', value: { kind: 'element_visible' } },
    ],
  },
  NavEdge: {
    schema: p.NavEdge,
    valid: [NAV_EDGE],
    invalid: [
      {
        why: 'trigger element id is not a uuid',
        value: withField(NAV_EDGE, 'triggerElementId', 'approve'),
      },
      { why: 'preconditions is not a list', value: withField(NAV_EDGE, 'preconditions', {}) },
    ],
  },
  MemoryVersionStatus: {
    schema: p.MemoryVersionStatus,
    valid: ['building', 'active', 'superseded', 'failed'],
    invalid: [{ why: 'a version never returns to draft', value: 'draft' }],
  },
  MemoryVersion: {
    schema: p.MemoryVersion,
    valid: [
      MEMORY_VERSION,
      { ...MEMORY_VERSION, status: 'failed', approvedBy: null, failureReason: 'login timed out' },
    ],
    invalid: [
      { why: 'versions start at 1', value: withField(MEMORY_VERSION, 'version', 0) },
      {
        why: 'approvedBy must be a uuid or null',
        value: withField(MEMORY_VERSION, 'approvedBy', 'lead@example.com'),
      },
    ],
  },
  AliasSource: {
    schema: p.AliasSource,
    valid: ['indexed', 't2_writeback', 'manual'],
    invalid: [{ why: 'aliases are never guessed', value: 'guessed' }],
  },
  Alias: {
    schema: p.Alias,
    valid: [ALIAS, { ...ALIAS, stateFingerprint: null, source: 'indexed' }],
    invalid: [
      { why: 'empty phrase', value: withField(ALIAS, 'phrase', '') },
      { why: 'negative hit count', value: withField(ALIAS, 'hits', -1) },
    ],
  },
  MemorySnapshot: {
    schema: p.MemorySnapshot,
    valid: [
      {
        tenantId: UUID_A,
        applicationId: UUID_B,
        memoryVersion: MEMORY_VERSION,
        screens: [SCREEN_NODE],
        elements: [ELEMENT_RECORD],
        navEdges: [NAV_EDGE],
        aliases: [ALIAS],
        generatedAt: NOW,
      },
    ],
    invalid: [
      {
        why: 'screens must be a list, not a keyed map',
        value: {
          tenantId: UUID_A,
          applicationId: UUID_B,
          memoryVersion: MEMORY_VERSION,
          screens: { [UUID_B]: SCREEN_NODE },
          elements: [],
          navEdges: [],
          aliases: [],
          generatedAt: NOW,
        },
      },
      {
        why: 'missing the memory version it describes',
        value: {
          tenantId: UUID_A,
          applicationId: UUID_B,
          screens: [],
          elements: [],
          navEdges: [],
          aliases: [],
          generatedAt: NOW,
        },
      },
    ],
  },

  /* ---------------------------------------------------------------------------- resolution */

  QueryConstraint: {
    schema: p.QueryConstraint,
    valid: [
      { kind: 'ordinal', index: 2 },
      { kind: 'within', landmark: 'region:orders' },
      { kind: 'value', text: 'Acme Industrial' },
    ],
    invalid: [
      { why: 'ordinals are spoken one-based', value: { kind: 'ordinal', index: 0 } },
      { why: 'unknown constraint kind', value: { kind: 'colour', value: 'red' } },
    ],
  },
  ScopedQuery: {
    schema: p.ScopedQuery,
    valid: [SCOPED_QUERY, { ...SCOPED_QUERY, constraints: [], candidateElementKeys: [] }],
    invalid: [
      { why: 'unknown verb', value: withField(SCOPED_QUERY, 'verb', 'drag') },
      {
        why: 'no candidate set — resolution must never widen to the whole document',
        value: without(SCOPED_QUERY, 'candidateElementKeys'),
      },
    ],
  },
  ResolutionCandidate: {
    schema: p.ResolutionCandidate,
    valid: [RESOLUTION_CANDIDATE],
    invalid: [
      { why: 'confidence above 1', value: withField(RESOLUTION_CANDIDATE, 'confidence', 1.5) },
      {
        why: 'signal scores keyed to non-numbers',
        value: withField(RESOLUTION_CANDIDATE, 'signalScores', { role: 'high' }),
      },
    ],
  },
  ResolutionResult: {
    schema: p.ResolutionResult,
    valid: [
      RESOLUTION_RESULT,
      {
        outcome: 'ambiguous',
        tier: 'T1',
        latencyMs: 31.8,
        candidates: [RESOLUTION_CANDIDATE, SECOND_CANDIDATE],
      },
      { outcome: 'not_found', tier: 'T2', latencyMs: 612, candidates: [] },
    ],
    invalid: [
      {
        why: 'ambiguous with a single candidate is a resolution, not an ambiguity',
        value: {
          outcome: 'ambiguous',
          tier: 'T1',
          latencyMs: 31.8,
          candidates: [RESOLUTION_CANDIDATE],
        },
      },
      {
        why: 'not_found carrying candidates contradicts itself',
        value: {
          outcome: 'not_found',
          tier: 'T2',
          latencyMs: 612,
          candidates: [RESOLUTION_CANDIDATE],
        },
      },
      {
        why: 'resolved without an element id',
        value: without(RESOLUTION_RESULT, 'elementId'),
      },
    ],
  },

  /* ------------------------------------------------------------------------------- runtime */

  RuntimeState: {
    schema: p.RuntimeState,
    valid: [
      {
        route: '/orders/1841',
        routePattern: '/orders/:id',
        modalStack: [],
        focusedLandmark: 'region:orders',
        visibleElementKeys: ['orders.detail.approve'],
        structuralHash: HASH_A,
        stateFingerprint: HASH_C,
        capturedAt: NOW,
      },
      {
        route: '/orders/1841',
        routePattern: '/orders/:id',
        modalStack: ['Confirm approval'],
        focusedLandmark: null,
        visibleElementKeys: [],
        structuralHash: HASH_A,
        stateFingerprint: HASH_C,
        capturedAt: NOW,
      },
    ],
    invalid: [
      {
        why: 'visible set carries DOM nodes rather than element keys',
        value: {
          route: '/orders/1841',
          routePattern: '/orders/:id',
          modalStack: [],
          focusedLandmark: null,
          visibleElementKeys: [{}],
          structuralHash: HASH_A,
          stateFingerprint: HASH_C,
          capturedAt: NOW,
        },
      },
    ],
  },
  ActionPayload: {
    schema: p.ActionPayload,
    valid: [
      { verb: 'navigate', route: '/orders' },
      { verb: 'click' },
      { verb: 'type', text: 'Acme Industrial', clearFirst: true },
      { verb: 'focus' },
      { verb: 'scroll', direction: 'down', amountPx: 400 },
      { verb: 'scroll', direction: 'bottom', amountPx: null },
      { verb: 'filter', text: 'pending' },
      { verb: 'check', assertion: 'the status badge reads pending approval' },
      { verb: 'select', option: 'Net 30' },
      { verb: 'back' },
    ],
    invalid: [
      { why: 'type without any text to type', value: { verb: 'type', clearFirst: false } },
      { why: 'click carrying a payload it has no use for', value: { verb: 'click', text: 'x' } },
      { why: 'unknown verb', value: { verb: 'drag', from: 'a', to: 'b' } },
    ],
  },
  ActionRequest: {
    schema: p.ActionRequest,
    valid: [
      {
        id: UUID_A,
        sessionId: UUID_B,
        elementId: UUID_C,
        elementKey: 'orders.detail.approve',
        payload: { verb: 'focus' },
        actionClass: 'R',
        tier: 'T0',
        confidence: 0.98,
        speculative: true,
        confirmed: false,
        stateFingerprint: HASH_C,
        issuedAt: NOW,
      },
      {
        id: UUID_A,
        sessionId: UUID_B,
        elementId: UUID_C,
        elementKey: 'orders.detail.approve',
        payload: { verb: 'click' },
        actionClass: 'C',
        tier: 'T0',
        confidence: 0.98,
        speculative: false,
        confirmed: true,
        stateFingerprint: HASH_C,
        issuedAt: NOW,
      },
    ],
    invalid: [
      {
        why: 'a class C action marked speculative — the worst bug this product can have',
        value: {
          id: UUID_A,
          sessionId: UUID_B,
          elementId: UUID_C,
          elementKey: 'orders.detail.approve',
          payload: { verb: 'click' },
          actionClass: 'C',
          tier: 'T0',
          confidence: 0.99,
          speculative: true,
          confirmed: true,
          stateFingerprint: HASH_C,
          issuedAt: NOW,
        },
      },
      {
        why: 'a class C action dispatched without confirmation',
        value: {
          id: UUID_A,
          sessionId: UUID_B,
          elementId: UUID_C,
          elementKey: 'orders.detail.approve',
          payload: { verb: 'click' },
          actionClass: 'C',
          tier: 'T0',
          confidence: 0.99,
          speculative: false,
          confirmed: false,
          stateFingerprint: HASH_C,
          issuedAt: NOW,
        },
      },
      {
        why: 'a seeding action without an approved preview',
        value: {
          id: UUID_A,
          sessionId: UUID_B,
          elementId: UUID_C,
          elementKey: 'orders.create.submit',
          payload: { verb: 'click' },
          actionClass: 'S',
          tier: 'T0',
          confidence: 0.99,
          speculative: false,
          confirmed: false,
          stateFingerprint: HASH_C,
          issuedAt: NOW,
        },
      },
    ],
  },
  ActionOutcome: {
    schema: p.ActionOutcome,
    valid: ['executed', 'staged', 'rolled_back', 'rejected', 'failed'],
    invalid: [{ why: 'not a terminal state', value: 'pending' }],
  },
  EvidenceRef: {
    schema: p.EvidenceRef,
    valid: [EVIDENCE_REF, { ...EVIDENCE_REF, kind: 'dom_snapshot' }],
    invalid: [
      { why: 'unknown evidence kind', value: withField(EVIDENCE_REF, 'kind', 'video') },
      { why: 'content hash is not a digest', value: withField(EVIDENCE_REF, 'contentHash', 'abc') },
    ],
  },
  ActionResult: {
    schema: p.ActionResult,
    valid: [
      {
        actionRequestId: UUID_A,
        outcome: 'executed',
        latencyMs: 18.4,
        reason: null,
        evidence: [],
        completedAt: NOW,
      },
      {
        actionRequestId: UUID_A,
        outcome: 'rejected',
        latencyMs: 2,
        reason: 'the tester declined the confirmation',
        evidence: [EVIDENCE_REF],
        completedAt: NOW,
      },
    ],
    invalid: [
      {
        why: 'negative latency',
        value: {
          actionRequestId: UUID_A,
          outcome: 'executed',
          latencyMs: -3,
          reason: null,
          evidence: [],
          completedAt: NOW,
        },
      },
    ],
  },
  SessionStep: {
    schema: p.SessionStep,
    valid: [
      {
        id: UUID_A,
        sessionId: UUID_B,
        ordinal: 4,
        utterance: 'show me only the pending ones',
        intent: SCOPED_QUERY,
        resolution: RESOLUTION_RESULT,
        elementId: UUID_C,
        tier: 'T0',
        confidence: 0.97,
        actionClass: 'R',
        latencyMs: 312,
        outcome: 'executed',
        evidence: [EVIDENCE_REF],
        createdAt: NOW,
      },
      {
        id: UUID_A,
        sessionId: UUID_B,
        ordinal: 5,
        utterance: 'approve it',
        intent: SCOPED_QUERY,
        resolution: { outcome: 'not_found', tier: 'T2', latencyMs: 780, candidates: [] },
        elementId: null,
        tier: null,
        confidence: null,
        actionClass: null,
        latencyMs: 900,
        outcome: 'failed',
        evidence: [],
        createdAt: NOW,
      },
    ],
    invalid: [
      {
        why: 'ordinals are zero-based and never negative',
        value: {
          id: UUID_A,
          sessionId: UUID_B,
          ordinal: -1,
          utterance: 'approve it',
          intent: SCOPED_QUERY,
          resolution: RESOLUTION_RESULT,
          elementId: UUID_C,
          tier: 'T0',
          confidence: 0.9,
          actionClass: 'C',
          latencyMs: 100,
          outcome: 'executed',
          evidence: [],
          createdAt: NOW,
        },
      },
    ],
  },

  /* ---------------------------------------------------------------------------------- data */

  FieldType: {
    schema: p.FieldType,
    valid: ['currency', 'reference', 'group'],
    invalid: [{ why: 'inference never produces a bare object type', value: 'object' }],
  },
  FieldValueConstraints: {
    schema: p.FieldValueConstraints,
    valid: [
      FIELD_VALUE_CONSTRAINTS,
      { min: null, max: null, minLength: null, maxLength: null, pattern: '^ORD-\\d+$' },
    ],
    invalid: [
      {
        why: 'negative maximum length',
        value: withField(FIELD_VALUE_CONSTRAINTS, 'maxLength', -1),
      },
      {
        why: 'pattern omitted rather than explicitly null',
        value: without(FIELD_VALUE_CONSTRAINTS, 'pattern'),
      },
    ],
  },
  DistributionShape: {
    schema: p.DistributionShape,
    valid: [
      { kind: 'numeric', min: 800, max: 240000, mean: 32000, stddev: 18400, fit: 'lognormal' },
      {
        kind: 'categorical',
        frequencies: { Draft: 0.12, 'Pending approval': 0.44, Approved: 0.44 },
      },
      {
        kind: 'string_pattern',
        prefix: 'ORD-',
        minLength: 8,
        maxLength: 8,
        charset: 'alphanumeric',
      },
      { kind: 'temporal', minOffsetDays: -365, maxOffsetDays: 90 },
    ],
    invalid: [
      {
        why: 'negative standard deviation',
        value: { kind: 'numeric', min: 0, max: 1, mean: 0.5, stddev: -1, fit: 'normal' },
      },
      { why: 'a frequency above 1', value: { kind: 'categorical', frequencies: { Draft: 1.4 } } },
      { why: 'unknown distribution kind', value: { kind: 'poisson', lambda: 4 } },
    ],
  },
  FieldDistribution: {
    schema: p.FieldDistribution,
    valid: [FIELD_DISTRIBUTION],
    invalid: [
      { why: 'negative sample size', value: withField(FIELD_DISTRIBUTION, 'sampleSize', -1) },
      {
        why: 'raw observed values instead of a shape',
        value: withField(FIELD_DISTRIBUTION, 'shape', [800, 1200]),
      },
    ],
  },
  DerivedRuleSpec: {
    schema: p.DerivedRuleSpec,
    valid: [
      { kind: 'sum', overField: 'line_items', ofField: 'amount' },
      { kind: 'count', overField: 'line_items' },
      { kind: 'min', overField: 'line_items', ofField: 'ships_on' },
      { kind: 'max', overField: 'line_items', ofField: 'ships_on' },
      { kind: 'date_offset', fromField: 'created_at', offsetDays: 30 },
      { kind: 'concat', fields: ['prefix', 'sequence'], separator: '-' },
    ],
    invalid: [
      {
        why: 'concatenating a single field is not a rule',
        value: { kind: 'concat', fields: ['prefix'], separator: '-' },
      },
      {
        why: 'a hypothesis outside the closed set',
        value: { kind: 'regression', overField: 'amount' },
      },
    ],
  },
  DerivedRule: {
    schema: p.DerivedRule,
    valid: [{ rule: { kind: 'count', overField: 'line_items' }, confidence: 1, sampleSize: 128 }],
    invalid: [
      {
        why: 'confidence above 1',
        value: {
          rule: { kind: 'count', overField: 'line_items' },
          confidence: 1.2,
          sampleSize: 128,
        },
      },
      {
        why: 'no sample size to justify the confidence',
        value: { rule: { kind: 'count', overField: 'line_items' }, confidence: 1 },
      },
    ],
  },
  FieldSpec: {
    schema: p.FieldSpec,
    valid: [
      FIELD_SPEC,
      {
        ...FIELD_SPEC,
        name: 'status',
        type: 'enum',
        derivedRule: null,
        enumValues: ['Draft', 'Pending approval', 'Approved', 'Rejected'],
        distribution: null,
        controlElementKey: null,
      },
    ],
    invalid: [
      {
        why: 'enum values given as a comma-joined string',
        value: withField(FIELD_SPEC, 'enumValues', 'Draft,Approved'),
      },
      { why: 'unknown field type', value: withField(FIELD_SPEC, 'type', 'json') },
    ],
  },
  MaterializerKind: {
    schema: p.MaterializerKind,
    valid: ['api', 'ui', 'fixture'],
    invalid: [{ why: 'WisprTest never writes to the database directly', value: 'sql' }],
  },
  MaterializerSpec: {
    schema: p.MaterializerSpec,
    valid: [
      {
        kind: 'api',
        method: 'POST',
        path: '/api/v2/orders',
        payloadTemplate: {},
        auth: 'session',
        readBackPath: null,
      },
      { kind: 'ui', form: 'orders.create', route: '/orders/new' },
      { kind: 'fixture', command: 'rake wispr:seed[order]' },
    ],
    invalid: [
      {
        why: 'a create request is never a GET',
        value: {
          kind: 'api',
          method: 'GET',
          path: '/api/v2/orders',
          payloadTemplate: {},
          auth: 'session',
          readBackPath: null,
        },
      },
      {
        why: 'ui materializer without a route to drive',
        value: { kind: 'ui', form: 'orders.create' },
      },
    ],
  },
  MaterializerDescriptor: {
    schema: p.MaterializerDescriptor,
    valid: [MATERIALIZER_DESCRIPTOR, { ...MATERIALIZER_DESCRIPTOR, verifiedAt: null }],
    invalid: [
      {
        why: 'a verification TTL of zero hours would mean never verified',
        value: withField(MATERIALIZER_DESCRIPTOR, 'verificationTtlHours', 0),
      },
      { why: 'negative priority', value: withField(MATERIALIZER_DESCRIPTOR, 'priority', -1) },
    ],
  },
  PredicateOperand: {
    schema: p.PredicateOperand,
    valid: [
      { kind: 'literal', value: 'Paid' },
      { kind: 'now', offsetDays: -22 },
    ],
    invalid: [
      { why: 'now without an offset', value: { kind: 'now' } },
      { why: 'unknown operand kind', value: { kind: 'field', name: 'due_date' } },
    ],
  },
  PredicateClause: {
    schema: p.PredicateClause,
    valid: [{ field: 'due_date', op: 'lt', operand: { kind: 'now', offsetDays: 0 } }],
    invalid: [
      {
        why: 'operator written as a symbol rather than a name',
        value: { field: 'due_date', op: '<', operand: { kind: 'now', offsetDays: 0 } },
      },
      { why: 'no field to compare', value: { op: 'lt', operand: { kind: 'now', offsetDays: 0 } } },
    ],
  },
  PredicateDefinition: {
    schema: p.PredicateDefinition,
    valid: [
      PREDICATE_DEFINITION,
      { ...PREDICATE_DEFINITION, source: 'manual', confidence: 1, sampleSize: 0 },
    ],
    invalid: [
      {
        why: 'a predicate with no clauses is not a condition',
        value: withField(PREDICATE_DEFINITION, 'clauses', []),
      },
      {
        why: 'predicates are learned or authored, never assumed',
        value: withField(PREDICATE_DEFINITION, 'source', 'assumed'),
      },
    ],
  },
  EntitySchema: {
    schema: p.EntitySchema,
    valid: [
      ENTITY_SCHEMA,
      {
        ...ENTITY_SCHEMA,
        fields: [],
        materializers: [],
        predicates: [],
        observedCount: 0,
        confidence: 0,
      },
    ],
    invalid: [
      { why: 'entity name is empty', value: withField(ENTITY_SCHEMA, 'entityName', '') },
      {
        why: 'fields given as a keyed map rather than a list',
        value: withField(ENTITY_SCHEMA, 'fields', { amount: FIELD_SPEC }),
      },
    ],
  },
  Constraint: {
    schema: p.Constraint,
    valid: [
      { kind: 'equals', field: 'status', value: 'Pending approval' },
      { kind: 'reference', field: 'account', phrase: 'Acme Industrial' },
      { kind: 'cardinality', field: 'line_items', count: 3 },
      { kind: 'comparison', field: 'amount', op: 'gt', value: 50000 },
      { kind: 'predicate', name: 'overdue' },
    ],
    invalid: [
      {
        why: 'comparison against a non-numeric value',
        value: { kind: 'comparison', field: 'amount', op: 'gt', value: 'a lot' },
      },
      {
        why: 'a sixth constraint kind the parser cannot produce',
        value: { kind: 'regex', field: 'po_number', pattern: '^PO' },
      },
      {
        why: 'negative cardinality',
        value: { kind: 'cardinality', field: 'line_items', count: -1 },
      },
    ],
  },
  ConstraintSet: {
    schema: p.ConstraintSet,
    valid: [
      CONSTRAINT_SET,
      { ...CONSTRAINT_SET, constraints: [], unparsedFragments: ['with the usual terms'] },
    ],
    invalid: [
      { why: 'no entity to compose', value: without(CONSTRAINT_SET, 'entity') },
      { why: 'confidence above 1', value: withField(CONSTRAINT_SET, 'confidence', 1.4) },
    ],
  },
  ProvenanceSource: {
    schema: p.ProvenanceSource,
    valid: ['requested', 'reference_matched', 'sampled', 'derived', 'predicate_solved', 'default'],
    invalid: [{ why: 'nothing in a plan is unexplained', value: 'unknown' }],
  },
  ProvenanceEntry: {
    schema: p.ProvenanceEntry,
    valid: PROVENANCE,
    invalid: [
      {
        why: 'an empty explanation is exactly what makes seeding feel spooky',
        value: { field: 'amount', value: 46200, source: 'derived', explanation: '', confidence: 1 },
      },
      {
        why: 'unknown provenance source',
        value: {
          field: 'amount',
          value: 46200,
          source: 'magic',
          explanation: 'computed',
          confidence: 1,
        },
      },
    ],
  },
  CompositionNode: {
    schema: p.CompositionNode,
    valid: [
      COMPOSITION_NODE,
      {
        ...COMPOSITION_NODE,
        nodeId: 'account-1',
        entity: 'Account',
        mode: 'reuse_existing',
        existingExternalRef: 'ACC-118',
        fields: {},
        provenance: [],
      },
    ],
    invalid: [
      {
        why: 'a node is either created or reused, nothing else',
        value: withField(COMPOSITION_NODE, 'mode', 'update'),
      },
      { why: 'node id is empty', value: withField(COMPOSITION_NODE, 'nodeId', '') },
    ],
  },
  CompositionEdge: {
    schema: p.CompositionEdge,
    valid: [{ fromNodeId: 'order-1', toNodeId: 'account-1', viaField: 'account' }],
    invalid: [
      {
        why: 'an edge with no field to carry the reference',
        value: { fromNodeId: 'order-1', toNodeId: 'account-1' },
      },
    ],
  },
  CompositionPlan: {
    schema: p.CompositionPlan,
    valid: [COMPOSITION_PLAN],
    invalid: [
      {
        why: 'a plan with no records is not a plan',
        value: withField(COMPOSITION_PLAN, 'nodes', []),
      },
      {
        why: 'no materialization order for a dependency graph',
        value: withField(COMPOSITION_PLAN, 'materializationOrder', []),
      },
    ],
  },
  InverseOperation: {
    schema: p.InverseOperation,
    valid: [
      INVERSE_OP,
      { kind: 'ui', flow: 'orders.detail.delete' },
      { kind: 'fixture', command: 'rake wispr:destroy[ORD-4903]' },
      { kind: 'none', reason: 'this application exposes no delete flow for orders' },
    ],
    invalid: [
      {
        why: 'an inverse that creates rather than removes',
        value: { kind: 'api', method: 'POST', path: '/api/v2/orders' },
      },
      { why: '"none" without a reason to show in the preview', value: { kind: 'none' } },
    ],
  },
  MaterializationAttempt: {
    schema: p.MaterializationAttempt,
    valid: [
      {
        adapter: 'api',
        outcome: 'failed',
        reason: 'the create endpoint returned 422',
        durationMs: 180,
      },
      { adapter: 'ui', outcome: 'succeeded', reason: null, durationMs: 4200 },
    ],
    invalid: [
      {
        why: 'unknown attempt outcome',
        value: { adapter: 'ui', outcome: 'maybe', reason: null, durationMs: 1 },
      },
      {
        why: 'reason omitted rather than explicitly null',
        value: { adapter: 'ui', outcome: 'succeeded', durationMs: 1 },
      },
    ],
  },
  MaterializedRecord: {
    schema: p.MaterializedRecord,
    valid: [
      MATERIALIZED_RECORD,
      { ...MATERIALIZED_RECORD, inverseOp: { kind: 'none', reason: 'no delete flow was indexed' } },
    ],
    invalid: [
      {
        why: 'no external reference to point the tester at',
        value: withField(MATERIALIZED_RECORD, 'externalRef', ''),
      },
      {
        why: 'inverse operation omitted — reversibility is not optional',
        value: without(MATERIALIZED_RECORD, 'inverseOp'),
      },
    ],
  },
  MaterializationResult: {
    schema: p.MaterializationResult,
    valid: [
      {
        planId: UUID_A,
        outcome: 'created',
        adapterUsed: 'ui',
        attempts: [
          {
            adapter: 'api',
            outcome: 'failed',
            reason: 'the create endpoint returned 422',
            durationMs: 180,
          },
          { adapter: 'ui', outcome: 'succeeded', reason: null, durationMs: 4200 },
        ],
        records: [MATERIALIZED_RECORD],
        verifiedAt: NOW,
        failureReason: null,
        durationMs: 4380,
      },
      {
        planId: UUID_A,
        outcome: 'failed',
        adapterUsed: null,
        attempts: [
          {
            adapter: 'ui',
            outcome: 'failed',
            reason: 'the create form rejected the amount',
            durationMs: 5100,
          },
        ],
        records: [],
        verifiedAt: null,
        failureReason: 'every adapter in the chain failed',
        durationMs: 5100,
      },
    ],
    invalid: [
      {
        why: 'no attempts recorded — the chain must always be auditable',
        value: {
          planId: UUID_A,
          outcome: 'created',
          adapterUsed: 'api',
          attempts: [],
          records: [MATERIALIZED_RECORD],
          verifiedAt: NOW,
          failureReason: null,
          durationMs: 200,
        },
      },
    ],
  },
  SeedLedgerEntry: {
    schema: p.SeedLedgerEntry,
    valid: [
      {
        id: UUID_A,
        tenantId: UUID_B,
        sessionId: UUID_C,
        planId: UUID_D,
        nodeId: 'order-1',
        entitySchemaId: UUID_B,
        entity: 'Order',
        externalRef: 'ORD-4903',
        adapterUsed: 'ui',
        payload: { id: 4903 },
        provenance: PROVENANCE,
        inverseOp: INVERSE_OP,
        createdAt: NOW,
        revertedAt: null,
      },
    ],
    invalid: [
      {
        why: 'no provenance — the preview would have nothing to explain',
        value: {
          id: UUID_A,
          tenantId: UUID_B,
          sessionId: UUID_C,
          planId: UUID_D,
          nodeId: 'order-1',
          entitySchemaId: UUID_B,
          entity: 'Order',
          externalRef: 'ORD-4903',
          adapterUsed: 'ui',
          payload: {},
          inverseOp: INVERSE_OP,
          createdAt: NOW,
          revertedAt: null,
        },
      },
    ],
  },

  /* --------------------------------------------------------------------------------- drift */

  ElementAddition: {
    schema: p.ElementAddition,
    valid: STRUCTURAL_DIFF.added,
    invalid: [
      {
        why: 'element key is not screen.component.element',
        value: {
          elementKey: 'archived',
          role: 'button',
          accessibleNameRedacted: 'Archived',
          landmarkPath: [],
        },
      },
    ],
  },
  ElementRemoval: {
    schema: p.ElementRemoval,
    valid: STRUCTURAL_DIFF.removed,
    invalid: [
      {
        why: 'no element id to migrate aliases from',
        value: { elementKey: 'orders.filter.draft', role: 'button' },
      },
    ],
  },
  ElementMove: {
    schema: p.ElementMove,
    valid: STRUCTURAL_DIFF.moved,
    invalid: [
      {
        why: 'match confidence above 1',
        value: {
          elementKey: 'orders.detail.approve',
          elementId: UUID_B,
          fromLandmarkPath: [],
          toLandmarkPath: [],
          matchConfidence: 1.3,
        },
      },
    ],
  },
  ElementRename: {
    schema: p.ElementRename,
    valid: STRUCTURAL_DIFF.renamed,
    invalid: [
      {
        why: 'the raw previous name instead of its digest — memory stores structure, not content',
        value: {
          elementKey: 'orders.filter.pending',
          elementId: UUID_C,
          fromNameHash: 'Pending',
          toNameHash: HASH_B,
          toNameRedacted: 'Awaiting approval',
          matchConfidence: 0.79,
        },
      },
    ],
  },
  SchemaChange: {
    schema: p.SchemaChange,
    valid: STRUCTURAL_DIFF.schemaChanges,
    invalid: [
      {
        why: 'unknown schema change kind',
        value: { entity: 'Order', kind: 'renamed', field: 'status', detail: 'x' },
      },
      {
        why: 'field omitted rather than explicitly null',
        value: { entity: 'Order', kind: 'field_added', detail: 'x' },
      },
    ],
  },
  StructuralDiff: {
    schema: p.StructuralDiff,
    valid: [STRUCTURAL_DIFF, { added: [], removed: [], moved: [], renamed: [], schemaChanges: [] }],
    invalid: [{ why: 'missing the renamed bucket', value: without(STRUCTURAL_DIFF, 'renamed') }],
  },
  DriftDetector: {
    schema: p.DriftDetector,
    valid: ['extension', 'indexer'],
    invalid: [{ why: 'the console reviews drift, it does not detect it', value: 'console' }],
  },
  DriftStatus: {
    schema: p.DriftStatus,
    valid: ['open', 'reconciling', 'diffed', 'approved', 'rejected'],
    invalid: [{ why: 'there is no auto-approved state, deliberately', value: 'auto_approved' }],
  },
  DriftReport: {
    schema: p.DriftReport,
    valid: [
      {
        id: UUID_A,
        tenantId: UUID_B,
        memoryVersionId: UUID_C,
        screenId: UUID_D,
        routePattern: '/orders/:id',
        stateFingerprint: HASH_C,
        expectedStructuralHash: HASH_A,
        observedStructuralHash: HASH_B,
        diff: STRUCTURAL_DIFF,
        status: 'diffed',
        detectedBy: 'extension',
        aliasMigrationRate: 0.82,
        approvedBy: null,
        createdAt: NOW,
        resolvedAt: null,
      },
      {
        id: UUID_A,
        tenantId: UUID_B,
        memoryVersionId: UUID_C,
        screenId: UUID_D,
        routePattern: '/orders/:id',
        stateFingerprint: HASH_C,
        expectedStructuralHash: HASH_A,
        observedStructuralHash: HASH_B,
        diff: null,
        status: 'open',
        detectedBy: 'extension',
        aliasMigrationRate: null,
        approvedBy: null,
        createdAt: NOW,
        resolvedAt: null,
      },
    ],
    invalid: [
      {
        why: 'approver recorded as a name rather than a user id',
        value: {
          id: UUID_A,
          tenantId: UUID_B,
          memoryVersionId: UUID_C,
          screenId: UUID_D,
          routePattern: '/orders/:id',
          stateFingerprint: HASH_C,
          expectedStructuralHash: HASH_A,
          observedStructuralHash: HASH_B,
          diff: null,
          status: 'approved',
          detectedBy: 'indexer',
          aliasMigrationRate: 1,
          approvedBy: 'priya',
          createdAt: NOW,
          resolvedAt: NOW,
        },
      },
    ],
  },

  /* -------------------------------------------------------------------------------- errors */

  WisprErrorCode: {
    schema: p.WisprErrorCode,
    valid: ['resolution_ambiguous', 'constraint_unsatisfiable', 'internal'],
    invalid: [{ why: 'not a code in the taxonomy', value: 'something_went_wrong' }],
  },
  ValidationIssue: {
    schema: p.ValidationIssue,
    valid: [{ path: 'nodes.0.fields.amount', message: 'expected a number' }],
    invalid: [{ why: 'empty path', value: { path: '', message: 'expected a number' } }],
  },
  WisprError: {
    schema: p.WisprError,
    valid: [
      {
        code: 'resolution_ambiguous',
        message: 'Two controls match "pending". Say one or two.',
        retryable: false,
        candidateElementKeys: ['orders.filter.pending', 'orders.status.pending'],
        tier: 'T1',
      },
      {
        code: 'resolution_not_found',
        message: 'Nothing on this screen matches "the archive toggle".',
        retryable: false,
        targetPhrase: 'the archive toggle',
        tier: 'T2',
      },
      {
        code: 'resolution_timeout',
        message: 'The model did not answer in time; falling back to disambiguation.',
        retryable: true,
        tier: 'T2',
        budgetMs: 800,
        elapsedMs: 812,
      },
      {
        code: 'memory_version_mismatch',
        message: 'This application was re-indexed. Refreshing memory.',
        retryable: true,
        expectedVersion: 18,
        actualVersion: 19,
      },
      {
        code: 'memory_snapshot_unavailable',
        message: 'This application has not finished indexing yet.',
        retryable: true,
        applicationId: UUID_A,
      },
      {
        code: 'action_confirmation_required',
        message: 'Approving an order needs an explicit yes.',
        retryable: false,
        actionClass: 'C',
      },
      {
        code: 'action_target_stale',
        message: 'The page changed while you were speaking. Say it again.',
        retryable: true,
        expectedStateFingerprint: HASH_C,
        observedStateFingerprint: HASH_A,
      },
      {
        code: 'action_dispatch_failed',
        message: 'The approve button did not accept the click.',
        retryable: true,
        elementKey: 'orders.detail.approve',
      },
      {
        code: 'constraint_unsatisfiable',
        message: 'An order cannot be both paid and overdue.',
        retryable: false,
        entity: 'Invoice',
        conflicting: [
          { kind: 'equals', field: 'status', value: 'Paid' },
          { kind: 'predicate', name: 'overdue' },
        ],
      },
      {
        code: 'schema_confidence_too_low',
        message: 'Too little is known about Order to create one. Index the create form first.',
        retryable: false,
        entity: 'Order',
        confidence: 0.31,
        threshold: 0.7,
        missingFields: ['terms', 'po_number'],
      },
      {
        code: 'reference_target_missing',
        message: 'No account called "Acme Industrial" exists yet.',
        retryable: false,
        entity: 'Order',
        field: 'account',
        phrase: 'Acme Industrial',
      },
      {
        code: 'uniqueness_exhausted',
        message: 'Could not find an unused purchase order number after 10 tries.',
        retryable: true,
        entity: 'Order',
        field: 'po_number',
        attempts: 10,
      },
      {
        code: 'materializer_unavailable',
        message: 'No way to create an Order has been learned for this application.',
        retryable: false,
        entity: 'Order',
        triedAdapters: ['fixture', 'api', 'ui'],
      },
      {
        code: 'materialization_failed',
        message: 'Every way of creating this order failed.',
        retryable: true,
        planId: UUID_A,
        adapter: 'ui',
      },
      {
        code: 'seeding_forbidden',
        message: 'Seeding is disabled for production.',
        retryable: false,
        applicationId: UUID_A,
        environment: 'production',
      },
      {
        code: 'drift_approval_required',
        message: 'This screen changed. A lead needs to approve the update.',
        retryable: false,
        driftReportId: UUID_A,
      },
      { code: 'unauthorized', message: 'Sign in to continue.', retryable: false },
      {
        code: 'forbidden',
        message: 'Approving a memory change needs the lead role.',
        retryable: false,
        requiredRole: 'lead',
      },
      {
        code: 'rate_limited',
        message: 'Too many requests.',
        retryable: true,
        retryAfterSeconds: 30,
      },
      {
        code: 'validation_failed',
        message: 'The plan did not match the contract.',
        retryable: false,
        issues: [{ path: 'nodes.0.fields.amount', message: 'expected a number' }],
      },
      {
        code: 'internal',
        message: 'Something failed unexpectedly. Quote this id to support.',
        retryable: true,
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      },
    ],
    invalid: [
      { why: 'unknown error code', value: { code: 'oops', message: 'x', retryable: false } },
      {
        why: 'a timeout marked non-retryable, contradicting the taxonomy',
        value: {
          code: 'resolution_timeout',
          message: 'x',
          retryable: false,
          tier: 'T2',
          budgetMs: 800,
          elapsedMs: 900,
        },
      },
      {
        why: 'an unsatisfiable set naming only one of the two colliding constraints',
        value: {
          code: 'constraint_unsatisfiable',
          message: 'x',
          retryable: false,
          entity: 'Invoice',
          conflicting: [{ kind: 'predicate', name: 'overdue' }],
        },
      },
      {
        why: 'an ambiguity with a single candidate',
        value: {
          code: 'resolution_ambiguous',
          message: 'x',
          retryable: false,
          candidateElementKeys: ['orders.filter.pending'],
          tier: 'T1',
        },
      },
    ],
  },
};
