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

const CRAWL_BOUNDS = {
  allowedOrigins: ['https://orders.northwind.example'],
  routeAllowlist: ['/orders', '/settings'],
  maxDepth: 3,
  maxPages: 200,
  neverInteractSelectors: ['[data-testid="order-delete"]', 'button[name="void"]'],
  maxInteractionsPerRoute: 12,
  interactionObserveMs: 1500,
  settleDelayMs: 250,
  networkIdleTimeoutMs: 5000,
  navigationTimeoutMs: 20_000,
  requestsPerMinute: 120,
  viewport: { width: 1280, height: 720 },
};

const CRAWL_JOB = {
  jobId: UUID_A,
  tenantId: UUID_B,
  applicationId: UUID_C,
  baseUrl: 'https://orders.northwind.example',
  bounds: CRAWL_BOUNDS,
  authProfile: {
    kind: 'form',
    loginPath: '/login',
    usernameLabel: 'Email address',
    passwordLabel: 'Password',
    submitLabel: 'Sign in',
    credentialsRef: { provider: 'env', key: 'NORTHWIND_CRAWLER_CREDENTIALS' },
    successPath: '/orders',
  },
  requestedBy: UUID_D,
  requestedAt: NOW,
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
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

const ESCALATION_CANDIDATE = {
  elementId: UUID_A,
  elementKey: 'orders.filter.pending',
  label: 'Pending',
};

const ESCALATE_REQUEST = {
  utterance: 'the ones still waiting on someone',
  stateFingerprint: HASH_C,
  candidates: [
    ESCALATION_CANDIDATE,
    { elementId: UUID_B, elementKey: 'orders.filter.approved', label: 'Approved' },
  ],
};

const EVIDENCE_REF = {
  kind: 'screenshot',
  storageKey: 'tenants/3f2504e0/sessions/9c5b94b1/step-4.png',
  contentHash: HASH_B,
  capturedAt: NOW,
};

const SESSION = {
  id: UUID_B,
  tenantId: UUID_A,
  applicationId: UUID_C,
  memoryVersionId: UUID_D,
  userId: UUID_A,
  startedAt: EARLIER,
  endedAt: null,
};

const SESSION_STEP = {
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

const EXISTING_RECORD = {
  entity: 'Account',
  externalRef: 'ACC-1001',
  label: 'Acme Industrial',
  fields: { id: 'ACC-1001', name: 'Acme Industrial', tier: 'enterprise' },
};

const CONSTRAINT_ALIAS = {
  phrase: 'high value',
  entity: 'Order',
  constraints: [{ kind: 'comparison', field: 'amount', op: 'gt', value: 50000 }],
  source: 't2_writeback',
  confidence: 0.88,
};

const CONSTRAINT_CONFLICT = {
  left: {
    kind: 'constraint',
    constraint: { kind: 'comparison', field: 'amount', op: 'gt', value: 50000 },
  },
  right: {
    kind: 'constraint',
    constraint: { kind: 'comparison', field: 'amount', op: 'lt', value: 1000 },
  },
  field: 'amount',
  explanation: 'amount cannot be both over 50,000 and under 1,000',
};

const COMPOSITION_REQUEST = {
  tenantId: UUID_A,
  sessionId: UUID_B,
  memoryVersionId: UUID_C,
  utterance: 'I need a pending order for Acme Industrial with three line items',
  schemas: [ENTITY_SCHEMA],
  runtimeState: {
    route: '/orders',
    routePattern: '/orders',
    modalStack: [],
    focusedLandmark: 'region:orders',
    visibleElementKeys: ['orders.orders.view'],
    structuralHash: HASH_A,
    stateFingerprint: HASH_C,
    capturedAt: NOW,
  },
  existingRecords: [EXISTING_RECORD],
  aliases: [CONSTRAINT_ALIAS],
  now: NOW,
  seed: 1841,
};

const COMPOSITION_RESPONSE = {
  constraintSet: CONSTRAINT_SET,
  outcome: { kind: 'planned', plan: COMPOSITION_PLAN, aliasWriteBacks: [] },
  parseTier: 'T0',
  durationMs: 412,
};

const INVERSE_OP = { kind: 'api', method: 'DELETE', path: '/api/v2/orders/4903' };

const MATERIALIZED_RECORD = {
  nodeId: 'order-1',
  entity: 'Order',
  externalRef: 'ORD-4903',
  payload: { id: 4903, status: 'Pending approval' },
  inverseOp: INVERSE_OP,
};

const SEED_REVERT_PLAN = {
  revertible: true,
  kind: 'ui',
  detail: 'drives the indexed delete flow orders-detail.order.delete on /orders/:id',
};

const SEED_NODE_PREVIEW = {
  nodeId: 'order-1',
  entity: 'Order',
  mode: 'create',
  adapter: 'ui',
  adapterReason: 'the API materializer has not been verified in 9 days, so the form will run',
  revert: SEED_REVERT_PLAN,
};

const SEED_PLAN_REQUEST = {
  sessionId: UUID_B,
  applicationId: UUID_C,
  utterance: 'I need a pending order for Acme Industrial with three line items',
  runtimeState: COMPOSITION_REQUEST.runtimeState,
  existingRecords: [EXISTING_RECORD],
  seed: 1841,
};

const SEED_PLAN_RESPONSE = {
  composition: COMPOSITION_RESPONSE,
  planId: UUID_A,
  preview: [SEED_NODE_PREVIEW],
  expiresAt: NOW,
};

const SEED_EXECUTE_RESPONSE = {
  result: {
    planId: UUID_A,
    outcome: 'created',
    adapterUsed: 'ui',
    attempts: [{ adapter: 'ui', outcome: 'succeeded', reason: null, durationMs: 4200 }],
    records: [MATERIALIZED_RECORD],
    verifiedAt: NOW,
    failureReason: null,
    durationMs: 4380,
  },
  ledger: [
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
};

const SEED_REVERT_OUTCOME = {
  ledgerEntryId: UUID_A,
  entity: 'Order',
  externalRef: 'ORD-4903',
  outcome: 'failed',
  reason: 'the delete flow returned the tester to /orders with the record still listed',
};

const UI_SEED_FIELD_VALUE = {
  field: 'status',
  controlElementKey: 'orders-new.create-order.status',
  value: 'Pending approval',
};

const UI_SEED_CREATE_JOB = {
  operation: 'create',
  jobId: UUID_A,
  tenantId: UUID_B,
  applicationId: UUID_C,
  memoryVersionId: UUID_D,
  sessionId: UUID_B,
  planId: UUID_C,
  nodeId: 'order-1',
  entity: 'Order',
  form: 'orders-new.create-order',
  route: '/orders/new',
  values: [UI_SEED_FIELD_VALUE],
  deadlineMs: 30000,
};

const UI_SEED_RESULT = {
  jobId: UUID_A,
  operation: 'create',
  outcome: 'succeeded',
  externalRef: 'ORD-4903',
  detailPath: '/orders/4903',
  failureReason: null,
  durationMs: 4200,
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
  HttpUrl: {
    schema: p.HttpUrl,
    valid: ['https://orders.northwind.example', 'http://localhost:4300/orders'],
    invalid: [
      { why: 'file scheme — the first SSRF defence', value: 'file:///etc/passwd' },
      { why: 'javascript scheme', value: 'javascript:alert(1)' },
      { why: 'a bare path, with no origin to check against an allowlist', value: '/orders' },
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
  AliasWriteback: {
    schema: p.AliasWriteback,
    valid: [
      {
        phrase: 'only the pending ones',
        elementId: UUID_A,
        stateFingerprint: HASH_C,
        source: 't2_writeback',
      },
      { phrase: 'the approve button', elementId: UUID_B, stateFingerprint: null, source: 'manual' },
    ],
    invalid: [
      {
        why: 'an indexed alias is written by the crawl, never fed back at runtime',
        value: { phrase: 'pending', elementId: UUID_A, stateFingerprint: null, source: 'indexed' },
      },
      {
        why: 'a write-back item carries no tenant — the scoped token supplies it',
        value: {
          phrase: 'pending',
          elementId: UUID_A,
          stateFingerprint: null,
          source: 'manual',
          tenantId: UUID_A,
        },
      },
    ],
  },
  AliasWritebackBatch: {
    schema: p.AliasWritebackBatch,
    valid: [
      {
        memoryVersionId: UUID_C,
        items: [
          {
            phrase: 'only the pending ones',
            elementId: UUID_A,
            stateFingerprint: HASH_C,
            source: 't2_writeback',
          },
        ],
      },
    ],
    invalid: [
      {
        why: 'an empty batch is a bug, not a no-op',
        value: { memoryVersionId: UUID_C, items: [] },
      },
      {
        why: 'the memory version is required — an alias is scoped to one',
        value: {
          items: [
            { phrase: 'pending', elementId: UUID_A, stateFingerprint: null, source: 'manual' },
          ],
        },
      },
    ],
  },
  AliasWritebackResult: {
    schema: p.AliasWritebackResult,
    valid: [
      { accepted: 3, inserted: 2, updated: 1 },
      { accepted: 0, inserted: 0, updated: 0 },
    ],
    invalid: [
      { why: 'counts are never negative', value: { accepted: -1, inserted: 0, updated: 0 } },
      { why: 'counts are integers', value: { accepted: 1.5, inserted: 1, updated: 0 } },
    ],
  },

  /* ------------------------------------------------------------------------------ indexing */

  SecretProvider: {
    schema: p.SecretProvider,
    valid: ['env', 'file'],
    invalid: [
      {
        why: 'an inline literal is not a reference — a credential may never appear in the contract',
        value: 'literal',
      },
    ],
  },
  SecretRef: {
    schema: p.SecretRef,
    valid: [
      { provider: 'env', key: 'NORTHWIND_CRAWLER_CREDENTIALS' },
      { provider: 'file', key: '/var/run/secrets/wispr/northwind.json' },
    ],
    invalid: [
      {
        why: 'carries the secret itself rather than a pointer to it',
        value: { provider: 'env', key: 'PASSWORD', value: 'hunter2' },
      },
      { why: 'empty key', value: { provider: 'env', key: '' } },
    ],
  },
  AuthProfile: {
    schema: p.AuthProfile,
    valid: [
      { kind: 'none' },
      CRAWL_JOB.authProfile,
      {
        kind: 'storage_state',
        stateRef: { provider: 'file', key: '/var/run/secrets/wispr/northwind-state.json' },
      },
    ],
    invalid: [
      {
        why: 'a password inlined instead of referenced',
        value: {
          kind: 'form',
          loginPath: '/login',
          usernameLabel: 'Email address',
          passwordLabel: 'Password',
          submitLabel: 'Sign in',
          password: 'hunter2',
          successPath: '/orders',
        },
      },
      {
        why: 'a storage state blob inlined instead of referenced — it holds live session cookies',
        value: { kind: 'storage_state', storageState: { cookies: [], origins: [] } },
      },
      { why: 'unknown auth kind', value: { kind: 'basic', credentialsRef: null } },
    ],
  },
  CrawlViewport: {
    schema: p.CrawlViewport,
    valid: [{ width: 1280, height: 720 }],
    invalid: [
      { why: 'narrower than any real browser', value: { width: 100, height: 720 } },
      { why: 'fractional pixels', value: { width: 1280.5, height: 720 } },
    ],
  },
  CrawlBounds: {
    schema: p.CrawlBounds,
    valid: [CRAWL_BOUNDS, { ...CRAWL_BOUNDS, neverInteractSelectors: [], routeAllowlist: ['/'] }],
    invalid: [
      {
        why: 'no page cap — an unbounded crawl must not be expressible',
        value: without(CRAWL_BOUNDS, 'maxPages'),
      },
      {
        why: 'no never-interact list, so nobody decided what must not be clicked',
        value: without(CRAWL_BOUNDS, 'neverInteractSelectors'),
      },
      {
        why: 'no rate limit',
        value: without(CRAWL_BOUNDS, 'requestsPerMinute'),
      },
      {
        why: 'empty origin allowlist would permit any target',
        value: withField(CRAWL_BOUNDS, 'allowedOrigins', []),
      },
    ],
  },
  CrawlJob: {
    schema: p.CrawlJob,
    valid: [CRAWL_JOB, { ...CRAWL_JOB, authProfile: { kind: 'none' }, traceparent: null }],
    invalid: [
      {
        why: 'a crawl target with a non-http scheme',
        value: withField(CRAWL_JOB, 'baseUrl', 'file:///etc/passwd'),
      },
      { why: 'no bounds at all', value: without(CRAWL_JOB, 'bounds') },
      {
        why: 'traceparent omitted rather than explicitly null',
        value: without(CRAWL_JOB, 'traceparent'),
      },
    ],
  },
  CrawlSkipReason: {
    schema: p.CrawlSkipReason,
    valid: ['off_allowlist', 'ssrf_rejected', 'page_cap_reached'],
    invalid: [
      { why: 'not a skip reason — a crawl never skips because it guessed', value: 'unsure' },
    ],
  },
  IndexFailureCode: {
    schema: p.IndexFailureCode,
    valid: ['ssrf_rejected', 'auth_failed', 'budget_exhausted'],
    invalid: [{ why: 'unknown failure code', value: 'unknown' }],
  },
  IndexProgressEvent: {
    schema: p.IndexProgressEvent,
    valid: [
      {
        kind: 'job_started',
        jobId: UUID_A,
        tenantId: UUID_B,
        sequence: 0,
        at: NOW,
        memoryVersionId: UUID_C,
        version: 4,
        resumed: false,
      },
      {
        kind: 'route_started',
        jobId: UUID_A,
        tenantId: UUID_B,
        sequence: 1,
        at: NOW,
        path: '/orders/1841',
        depth: 2,
      },
      {
        kind: 'route_indexed',
        jobId: UUID_A,
        tenantId: UUID_B,
        sequence: 2,
        at: NOW,
        screenId: UUID_D,
        routePattern: '/orders/:id',
        stateFingerprint: HASH_C,
        elementCount: 37,
        durationMs: 812.4,
      },
      {
        kind: 'route_skipped',
        jobId: UUID_A,
        tenantId: UUID_B,
        sequence: 3,
        at: NOW,
        path: '/admin/danger',
        reason: 'off_allowlist',
      },
      {
        kind: 'edge_recorded',
        jobId: UUID_A,
        tenantId: UUID_B,
        sequence: 4,
        at: NOW,
        fromScreenId: UUID_B,
        toScreenId: UUID_D,
        triggerElementKey: 'orders.list.row-link',
        confidence: 1,
      },
      {
        kind: 'job_completed',
        jobId: UUID_A,
        tenantId: UUID_B,
        sequence: 5,
        at: NOW,
        memoryVersionId: UUID_C,
        screenCount: 5,
        elementCount: 96,
        edgeCount: 7,
        durationMs: 42_310,
      },
      {
        kind: 'job_failed',
        jobId: UUID_A,
        tenantId: UUID_B,
        sequence: 6,
        at: NOW,
        memoryVersionId: UUID_C,
        code: 'auth_failed',
        detail: 'login did not reach /orders within the navigation timeout',
      },
      {
        kind: 'job_failed',
        jobId: UUID_A,
        tenantId: UUID_B,
        sequence: 0,
        at: NOW,
        memoryVersionId: null,
        code: 'bounds_invalid',
        detail: 'bounds.maxPages: Invalid input',
      },
    ],
    invalid: [
      {
        why: 'unknown event kind',
        value: { kind: 'route_guessed', jobId: UUID_A, tenantId: UUID_B, sequence: 0, at: NOW },
      },
      {
        why: 'no sequence, so a dropped event would be undetectable',
        value: {
          kind: 'route_started',
          jobId: UUID_A,
          tenantId: UUID_B,
          at: NOW,
          path: '/orders',
          depth: 0,
        },
      },
      {
        why: 'carries page text, which never leaves the browser',
        value: {
          kind: 'route_indexed',
          jobId: UUID_A,
          tenantId: UUID_B,
          sequence: 2,
          at: NOW,
          screenId: UUID_D,
          routePattern: '/orders/:id',
          stateFingerprint: HASH_C,
          elementCount: 37,
          durationMs: 812.4,
          heading: 'Order 1841 — Acme Industrial',
        },
      },
    ],
  },

  /* ---------------------------------------------------------------------------------- auth */

  ExtensionTokenScope: {
    schema: p.ExtensionTokenScope,
    valid: ['memory:read', 'session:write', 'seed:execute'],
    invalid: [
      { why: 'there is no wildcard scope, by design', value: '*' },
      {
        why: 'the extension never approves a drift report — it only reports one',
        value: 'drift:approve',
      },
    ],
  },
  ExtensionTokenRequest: {
    schema: p.ExtensionTokenRequest,
    valid: [{ origin: 'https://orders.northwind.example' }],
    invalid: [
      { why: 'an origin with a non-http scheme', value: { origin: 'chrome://extensions' } },
      {
        why: 'naming an application directly — the gateway resolves that from the origin',
        value: { origin: 'https://orders.northwind.example', applicationId: UUID_A },
      },
    ],
  },
  ExtensionToken: {
    schema: p.ExtensionToken,
    valid: [
      {
        token: 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.scoped.signature',
        tokenType: 'Bearer',
        expiresAt: NOW,
        tenantId: UUID_A,
        applicationId: UUID_B,
        scopes: ['memory:read', 'alias:write', 'session:write'],
      },
      {
        // A tester browsing an application nobody has indexed yet: a normal answer, not an error.
        token: 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.unscoped-app.signature',
        tokenType: 'Bearer',
        expiresAt: NOW,
        tenantId: UUID_A,
        applicationId: null,
        scopes: ['memory:read'],
      },
    ],
    invalid: [
      {
        why: 'no expiry, so the service worker could not refresh it before it failed',
        value: {
          token: 'opaque',
          tokenType: 'Bearer',
          tenantId: UUID_A,
          applicationId: UUID_B,
          scopes: ['memory:read'],
        },
      },
      {
        why: 'no scopes — a token that names no capability is not a scoped token',
        value: {
          token: 'opaque',
          tokenType: 'Bearer',
          expiresAt: NOW,
          tenantId: UUID_A,
          applicationId: UUID_B,
          scopes: [],
        },
      },
      {
        why: 'a token type the extension does not send',
        value: {
          token: 'opaque',
          tokenType: 'Basic',
          expiresAt: NOW,
          tenantId: UUID_A,
          applicationId: UUID_B,
          scopes: ['memory:read'],
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
  EscalationCandidate: {
    schema: p.EscalationCandidate,
    valid: [ESCALATION_CANDIDATE],
    invalid: [
      {
        why: 'carries a raw accessible name field the redaction contract forbids',
        value: withField(ESCALATION_CANDIDATE, 'accessibleName', 'Priya Sharma'),
      },
      {
        why: 'element key is not screen.component.element',
        value: withField(ESCALATION_CANDIDATE, 'elementKey', 'pending'),
      },
    ],
  },
  EscalateRequest: {
    schema: p.EscalateRequest,
    valid: [ESCALATE_REQUEST],
    invalid: [
      {
        why: 'no candidate set — a T2 escalation must never widen to the whole document',
        value: withField(ESCALATE_REQUEST, 'candidates', []),
      },
      {
        why: 'missing the state fingerprint the write-back keys on',
        value: without(ESCALATE_REQUEST, 'stateFingerprint'),
      },
    ],
  },
  EscalateResponse: {
    schema: p.EscalateResponse,
    valid: [
      { elementId: UUID_A, confidence: 0.88, reasoning: 'best matches the pending-orders filter' },
      {
        elementId: UUID_B,
        confidence: 0.34,
        reasoning: 'weak match; nearest is the approved filter',
      },
    ],
    invalid: [
      {
        why: 'confidence above 1',
        value: { elementId: UUID_A, confidence: 1.4, reasoning: 'over-confident' },
      },
      {
        why: 'empty reasoning is not a justification',
        value: { elementId: UUID_A, confidence: 0.9, reasoning: '' },
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

  Session: {
    schema: p.Session,
    valid: [SESSION, { ...SESSION, endedAt: NOW }],
    invalid: [
      {
        why: 'a session with no memory version records a timeline nobody can replay',
        value: without(SESSION, 'memoryVersionId'),
      },
      {
        why: 'endedAt must be a timestamp or null, never a status word',
        value: withField(SESSION, 'endedAt', 'closed'),
      },
    ],
  },
  SessionOpenRequest: {
    schema: p.SessionOpenRequest,
    valid: [{ applicationId: UUID_C, memoryVersionId: UUID_D }],
    invalid: [
      {
        why: 'the tenant comes from the token; naming one here would let a caller pick it',
        value: { applicationId: UUID_C, memoryVersionId: UUID_D, tenantId: UUID_A },
      },
      {
        why: 'missing the memory version the session resolves against',
        value: { applicationId: UUID_C },
      },
    ],
  },
  SessionCloseRequest: {
    schema: p.SessionCloseRequest,
    valid: [{ status: 'closed' }],
    invalid: [
      {
        why: 'an empty body must not close a session by accident',
        value: {},
      },
      {
        why: 'the server stamps endedAt; a client clock must not be able to backdate evidence',
        value: { status: 'closed', endedAt: NOW },
      },
      { why: 'reopening is not a transition that exists', value: { status: 'open' } },
    ],
  },
  SessionStepBatch: {
    schema: p.SessionStepBatch,
    valid: [{ steps: [SESSION_STEP] }, { steps: [SESSION_STEP, { ...SESSION_STEP, ordinal: 5 }] }],
    invalid: [
      { why: 'an empty batch is a bug, not a no-op', value: { steps: [] } },
      {
        why: 'a step that is not a SessionStep',
        value: { steps: [withField(SESSION_STEP, 'ordinal', -1)] },
      },
    ],
  },
  SessionStepIngestResult: {
    schema: p.SessionStepIngestResult,
    valid: [
      { accepted: 6, inserted: 6, duplicates: 0 },
      // An entirely duplicate flush: the previous attempt landed and the buffer was never told.
      { accepted: 6, inserted: 0, duplicates: 6 },
    ],
    invalid: [
      { why: 'counts are never negative', value: { accepted: 1, inserted: -1, duplicates: 2 } },
      {
        why: 'missing the duplicate count that makes a retry legible',
        value: { accepted: 1, inserted: 1 },
      },
    ],
  },
  SignedEvidence: {
    schema: p.SignedEvidence,
    valid: [
      {
        storageKey: 'tenants/3f2504e0/sessions/9c5b94b1/step-4.png',
        url: 'https://evidence.wisprtest.example/tenants/3f2504e0/step-4.png?sig=abc',
        expiresAt: NOW,
      },
    ],
    invalid: [
      {
        why: 'a signed URL that never expires is a permanent link to a customer screenshot',
        value: {
          storageKey: 'tenants/3f2504e0/sessions/9c5b94b1/step-4.png',
          url: 'https://evidence.wisprtest.example/step-4.png',
        },
      },
      {
        why: 'not a URL',
        value: { storageKey: 'k', url: 'step-4.png', expiresAt: NOW },
      },
    ],
  },
  SessionTimeline: {
    schema: p.SessionTimeline,
    valid: [
      {
        session: { ...SESSION, endedAt: NOW },
        steps: [SESSION_STEP],
        evidence: [
          {
            storageKey: EVIDENCE_REF.storageKey,
            url: 'https://evidence.wisprtest.example/tenants/3f2504e0/step-4.png?sig=abc',
            expiresAt: NOW,
          },
        ],
      },
      // An open session with nothing recorded yet is a timeline, not an error.
      { session: SESSION, steps: [], evidence: [] },
    ],
    invalid: [
      {
        why: 'steps without the session they belong to',
        value: { steps: [SESSION_STEP], evidence: [] },
      },
      {
        why: 'evidence must be resolved references, not raw bytes',
        value: { session: SESSION, steps: [], evidence: ['<html>…</html>'] },
      },
    ],
  },

  EvidenceUploadRequest: {
    schema: p.EvidenceUploadRequest,
    valid: [
      { kind: 'screenshot', stepOrdinal: 4, contentHash: HASH_B, contentType: 'image/png' },
      { kind: 'dom_snapshot', stepOrdinal: 0, contentHash: HASH_A, contentType: 'text/html' },
    ],
    invalid: [
      {
        why: 'the bytes themselves never cross — only a hash and a place to put them',
        value: {
          kind: 'screenshot',
          stepOrdinal: 4,
          contentHash: HASH_B,
          contentType: 'image/png',
          body: 'iVBORw0KGgo=',
        },
      },
      {
        why: 'a hash that is not a SHA-256 cannot key an object or verify one',
        value: { kind: 'screenshot', stepOrdinal: 4, contentHash: 'abc', contentType: 'image/png' },
      },
    ],
  },
  EvidenceUploadTicket: {
    schema: p.EvidenceUploadTicket,
    valid: [
      {
        storageKey: 'tenants/3f2504e0/sessions/9c5b94b1/4-screenshot-bbbbbbbbbbbbbbbb.png',
        uploadUrl: 'https://evidence.wisprtest.example/tenants/3f2504e0/4.png?sig=put',
        expiresAt: NOW,
      },
    ],
    invalid: [
      {
        why: 'an upload URL that never expires is a standing write authorisation',
        value: {
          storageKey: 'tenants/3f2504e0/sessions/9c5b94b1/4-screenshot.png',
          uploadUrl: 'https://evidence.wisprtest.example/4.png?sig=put',
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
      // An entry whose learned schema was dropped by a re-index. The record still exists in the
      // customer's application, and is still revertible.
      {
        id: UUID_A,
        tenantId: UUID_B,
        sessionId: UUID_C,
        planId: UUID_D,
        nodeId: 'order-1',
        entitySchemaId: null,
        entity: 'Order',
        externalRef: 'ORD-4903',
        adapterUsed: 'ui',
        payload: { id: 4903 },
        provenance: PROVENANCE,
        inverseOp: INVERSE_OP,
        createdAt: NOW,
        revertedAt: NOW,
      },
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

  /* --------------------------------------------------------------------------- composition */

  ExistingRecord: {
    schema: p.ExistingRecord,
    valid: [
      EXISTING_RECORD,
      // A record with no human-readable name. Its identifier is still a valid reference target.
      { ...EXISTING_RECORD, label: null },
    ],
    invalid: [
      {
        why: 'a reference target with no identifier cannot be pointed at',
        value: withField(EXISTING_RECORD, 'externalRef', ''),
      },
      { why: 'no entity to attribute the record to', value: without(EXISTING_RECORD, 'entity') },
    ],
  },

  ConstraintAlias: {
    schema: p.ConstraintAlias,
    valid: [CONSTRAINT_ALIAS, { ...CONSTRAINT_ALIAS, source: 'manual', confidence: 1 }],
    invalid: [
      {
        why: 'an alias that maps to no constraint explains nothing',
        value: withField(CONSTRAINT_ALIAS, 'constraints', []),
      },
      {
        why: 'write-back sources are a closed set',
        value: withField(CONSTRAINT_ALIAS, 'source', 'guessed'),
      },
    ],
  },

  CompositionRequest: {
    schema: p.CompositionRequest,
    valid: [
      COMPOSITION_REQUEST,
      // Nothing to resolve a reference against, and no learned phrasings yet: a first request
      // against a freshly indexed application looks exactly like this.
      { ...COMPOSITION_REQUEST, existingRecords: [], aliases: [], seed: null },
    ],
    invalid: [
      {
        why: 'no schema to compose against',
        value: withField(COMPOSITION_REQUEST, 'schemas', []),
      },
      {
        why: 'nothing was said',
        value: withField(COMPOSITION_REQUEST, 'utterance', ''),
      },
      {
        why: 'evaluation time must be supplied, so a plan is reproducible',
        value: without(COMPOSITION_REQUEST, 'now'),
      },
    ],
  },

  ConflictSide: {
    schema: p.ConflictSide,
    valid: [
      {
        kind: 'constraint',
        constraint: { kind: 'comparison', field: 'amount', op: 'gt', value: 50000 },
      },
      { kind: 'schema', field: 'status', detail: 'accepts only Draft, Pending approval, Approved' },
    ],
    invalid: [
      { why: 'unknown side kind', value: { kind: 'inference', field: 'status', detail: 'x' } },
      {
        why: 'a schema side that says nothing about the schema',
        value: { kind: 'schema', field: 'status', detail: '' },
      },
    ],
  },

  ConstraintConflict: {
    schema: p.ConstraintConflict,
    valid: [CONSTRAINT_CONFLICT, { ...CONSTRAINT_CONFLICT, field: null }],
    invalid: [
      {
        why: 'a conflict a tester cannot act on is not a report',
        value: withField(CONSTRAINT_CONFLICT, 'explanation', ''),
      },
      { why: 'a conflict needs both sides', value: without(CONSTRAINT_CONFLICT, 'right') },
    ],
  },

  CompositionOutcome: {
    schema: p.CompositionOutcome,
    valid: [
      { kind: 'planned', plan: COMPOSITION_PLAN, aliasWriteBacks: [CONSTRAINT_ALIAS] },
      // A parse that learned nothing new is the common case once an application is warm.
      { kind: 'planned', plan: COMPOSITION_PLAN, aliasWriteBacks: [] },
      { kind: 'conflict', constraintSet: CONSTRAINT_SET, conflict: CONSTRAINT_CONFLICT },
      {
        kind: 'refused',
        constraintSet: CONSTRAINT_SET,
        entity: 'Order',
        missingFields: ['terms'],
        reason: 'no distribution was learned for terms, so a value would be a guess',
      },
    ],
    invalid: [
      {
        why: 'a refusal that does not say what is missing is not a refusal',
        value: {
          kind: 'refused',
          constraintSet: CONSTRAINT_SET,
          entity: 'Order',
          missingFields: ['terms'],
          reason: '',
        },
      },
      {
        why: 'unknown outcome kind',
        value: { kind: 'deferred', plan: COMPOSITION_PLAN, aliasWriteBacks: [] },
      },
    ],
  },

  CompositionResponse: {
    schema: p.CompositionResponse,
    valid: [
      COMPOSITION_RESPONSE,
      {
        ...COMPOSITION_RESPONSE,
        parseTier: 'T2',
        outcome: { kind: 'conflict', constraintSet: CONSTRAINT_SET, conflict: CONSTRAINT_CONFLICT },
      },
    ],
    invalid: [
      {
        why: 'parse tiers are the closed set from the resolution contract',
        value: withField(COMPOSITION_RESPONSE, 'parseTier', 'T3'),
      },
      {
        why: 'a negative duration',
        value: withField(COMPOSITION_RESPONSE, 'durationMs', -1),
      },
    ],
  },

  /* ------------------------------------------------------------------------------- seeding */

  SeedRevertPlan: {
    schema: p.SeedRevertPlan,
    valid: [
      SEED_REVERT_PLAN,
      {
        revertible: false,
        kind: 'none',
        detail: 'no delete flow was indexed for Order — this record will remain',
      },
    ],
    invalid: [
      {
        why: 'claims to be revertible while naming no adapter to revert it with',
        value: { revertible: true, kind: 'none', detail: 'x' },
      },
      {
        why: 'names a delete flow but tells the tester it cannot be undone',
        value: { revertible: false, kind: 'ui', detail: 'drives orders.detail.delete' },
      },
    ],
  },
  SeedNodePreview: {
    schema: p.SeedNodePreview,
    valid: [
      SEED_NODE_PREVIEW,
      {
        nodeId: 'account-1',
        entity: 'Account',
        mode: 'reuse_existing',
        adapter: null,
        adapterReason: 'Acme Industrial already exists; nothing will be created for it',
        revert: {
          revertible: false,
          kind: 'none',
          detail: 'nothing is created for a reused record, so there is nothing to undo',
        },
      },
    ],
    invalid: [
      {
        why: 'a reused record naming an adapter that would write it again',
        value: withField(SEED_NODE_PREVIEW, 'mode', 'reuse_existing'),
      },
      {
        why: 'a created record with no adapter — the preview would not say what will run',
        value: withField(SEED_NODE_PREVIEW, 'adapter', null),
      },
    ],
  },
  SeedPlanRequest: {
    schema: p.SeedPlanRequest,
    valid: [
      SEED_PLAN_REQUEST,
      // No records to resolve against: every reference becomes a node of the graph instead.
      { ...SEED_PLAN_REQUEST, existingRecords: [], seed: null },
    ],
    invalid: [
      {
        why: 'an empty utterance asks for nothing',
        value: withField(SEED_PLAN_REQUEST, 'utterance', ''),
      },
      {
        why: 'naming a memory version the session does not belong to',
        value: { ...SEED_PLAN_REQUEST, memoryVersionId: UUID_D },
      },
    ],
  },
  SeedPlanResponse: {
    schema: p.SeedPlanResponse,
    valid: [
      SEED_PLAN_RESPONSE,
      {
        composition: {
          ...COMPOSITION_RESPONSE,
          outcome: {
            kind: 'conflict',
            constraintSet: CONSTRAINT_SET,
            conflict: CONSTRAINT_CONFLICT,
          },
        },
        planId: null,
        preview: [],
        expiresAt: null,
      },
    ],
    invalid: [
      {
        why: 'a plan was composed but nothing is holding it for approval',
        value: withField(SEED_PLAN_RESPONSE, 'planId', null),
      },
      {
        why: 'a held plan with no expiry — an approval could arrive against stale memory',
        value: withField(SEED_PLAN_RESPONSE, 'expiresAt', null),
      },
    ],
  },
  SeedExecuteRequest: {
    schema: p.SeedExecuteRequest,
    valid: [{ sessionId: UUID_B, planId: UUID_A, approvedAt: NOW }],
    invalid: [
      {
        why: 'carrying the plan instead of naming it — the previewed bytes must be the written ones',
        value: { sessionId: UUID_B, planId: UUID_A, approvedAt: NOW, plan: COMPOSITION_PLAN },
      },
      {
        why: 'no approval instant to audit',
        value: { sessionId: UUID_B, planId: UUID_A },
      },
    ],
  },
  SeedExecuteResponse: {
    schema: p.SeedExecuteResponse,
    valid: [
      SEED_EXECUTE_RESPONSE,
      // A chain that failed everywhere: an answer, with the attempts as the explanation.
      {
        result: {
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
        ledger: [],
      },
    ],
    invalid: [
      {
        why: 'no result — a write with no account of what it did',
        value: without(SEED_EXECUTE_RESPONSE, 'result'),
      },
    ],
  },
  SeedRevertRequest: {
    schema: p.SeedRevertRequest,
    valid: [
      { scope: 'entry', ledgerEntryId: UUID_A },
      { scope: 'session', sessionId: UUID_B },
    ],
    invalid: [
      {
        why: 'a tenant-wide revert is not a scope the API offers',
        value: { scope: 'tenant', tenantId: UUID_A },
      },
      {
        why: 'the session scope carrying an entry id',
        value: { scope: 'session', ledgerEntryId: UUID_A },
      },
    ],
  },
  SeedRevertOutcome: {
    schema: p.SeedRevertOutcome,
    valid: [
      SEED_REVERT_OUTCOME,
      {
        ...SEED_REVERT_OUTCOME,
        outcome: 'not_revertible',
        reason: 'no delete flow was indexed for Order; remove ORD-4903 by hand',
      },
      { ...SEED_REVERT_OUTCOME, outcome: 'reverted', reason: null },
    ],
    invalid: [
      {
        why: 'a failure with no reason the tester can act on',
        value: withField(SEED_REVERT_OUTCOME, 'reason', null),
      },
      {
        why: 'a successful revert still explaining itself, which reads as a failure',
        value: { ...SEED_REVERT_OUTCOME, outcome: 'reverted' },
      },
    ],
  },
  SeedRevertResponse: {
    schema: p.SeedRevertResponse,
    valid: [
      { outcomes: [SEED_REVERT_OUTCOME], durationMs: 3200 },
      // Nothing outstanding to revert is a normal answer, not an error.
      { outcomes: [], durationMs: 4 },
    ],
    invalid: [
      {
        why: 'a negative duration',
        value: { outcomes: [], durationMs: -1 },
      },
    ],
  },
  UiSeedFieldValue: {
    schema: p.UiSeedFieldValue,
    valid: [UI_SEED_FIELD_VALUE, { ...UI_SEED_FIELD_VALUE, value: null }],
    invalid: [
      {
        why: 'a CSS selector instead of an element key — the adapter resolves through memory',
        value: withField(UI_SEED_FIELD_VALUE, 'controlElementKey', '#order-status'),
      },
      {
        why: 'no field name to blame when the control cannot be found',
        value: without(UI_SEED_FIELD_VALUE, 'field'),
      },
    ],
  },
  UiSeedJob: {
    schema: p.UiSeedJob,
    valid: [
      UI_SEED_CREATE_JOB,
      {
        operation: 'revert',
        jobId: UUID_A,
        tenantId: UUID_B,
        applicationId: UUID_C,
        memoryVersionId: UUID_D,
        entity: 'Order',
        flow: 'orders.order.delete',
        externalRef: 'ORD-4903',
        detailPath: '/orders/4903',
        deadlineMs: 30000,
      },
    ],
    invalid: [
      {
        why: 'a create job with no control to fill',
        value: withField(UI_SEED_CREATE_JOB, 'values', []),
      },
      {
        why: 'unknown operation',
        value: withField(UI_SEED_CREATE_JOB, 'operation', 'update'),
      },
    ],
  },
  UiSeedResult: {
    schema: p.UiSeedResult,
    valid: [
      UI_SEED_RESULT,
      {
        jobId: UUID_A,
        operation: 'revert',
        outcome: 'succeeded',
        externalRef: null,
        detailPath: null,
        failureReason: null,
        durationMs: 2800,
      },
      {
        jobId: UUID_A,
        operation: 'create',
        outcome: 'failed',
        externalRef: null,
        detailPath: null,
        failureReason: 'the form rejected the amount: "must be at least 1"',
        durationMs: 5100,
      },
    ],
    invalid: [
      {
        why: 'a create that succeeded without reading back an identifier — nothing could revert it',
        value: withField(UI_SEED_RESULT, 'externalRef', null),
      },
      {
        why: 'a failure with nothing to tell the tester',
        value: { ...UI_SEED_RESULT, outcome: 'failed' },
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
        code: 'session_closed',
        message: 'That session was closed. Its timeline is final; open a new one to keep testing.',
        retryable: false,
        sessionId: UUID_B,
        endedAt: NOW,
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
