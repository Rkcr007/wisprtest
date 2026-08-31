import type {
  DriftDecisionResponse,
  DriftListResponse,
  DriftReport,
  FalseExecutionReport,
  SessionStep,
  SessionTimeline,
  StructuralDiff,
} from 'protocol';

/**
 * Contract-valid fixtures for drift and session screens.
 *
 * Shapes match `packages/protocol` fixtures so a test that parses them is also a contract check.
 * Not served to a tester — imported only by tests and by Story-less component renders.
 */

export const APPLICATION_ID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
export const REPORT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
export const SESSION_ID = '9c5b94b1-35ad-49bb-b118-8e8fc24abf80';
export const TENANT_ID = '11111111-1111-4111-8111-111111111111';
export const MEMORY_VERSION_ID = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
export const CANDIDATE_VERSION_ID = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
export const USER_ID = '11111111-1111-4111-8111-111111111111';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = '0f'.repeat(32);
const NOW = '2026-07-25T09:30:00.000Z';
const EARLIER = '2026-07-24T15:05:12.000Z';

export const STRUCTURAL_DIFF: StructuralDiff = {
  added: [
    {
      elementKey: 'orders.filter.archived',
      role: 'button',
      accessibleNameRedacted: 'Archived',
      landmarkPath: ['main', 'region:orders'],
    },
  ],
  removed: [{ elementKey: 'orders.filter.draft', elementId: REPORT_ID, role: 'button' }],
  moved: [
    {
      elementKey: 'orders.detail.approve',
      elementId: SESSION_ID,
      fromLandmarkPath: ['main'],
      toLandmarkPath: ['main', 'region:actions'],
      matchConfidence: 0.82,
    },
  ],
  renamed: [
    {
      elementKey: 'orders.filter.pending',
      elementId: APPLICATION_ID,
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

export const DIFFED_REPORT: DriftReport = {
  id: REPORT_ID,
  tenantId: TENANT_ID,
  memoryVersionId: MEMORY_VERSION_ID,
  candidateMemoryVersionId: CANDIDATE_VERSION_ID,
  screenId: CANDIDATE_VERSION_ID,
  routePattern: '/orders/:id',
  observedRoute: '/orders/4903',
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
};

export const OPEN_REPORT: DriftReport = {
  ...DIFFED_REPORT,
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  candidateMemoryVersionId: null,
  diff: null,
  status: 'open',
  aliasMigrationRate: null,
};

export const DRIFT_LIST: DriftListResponse = {
  reports: [DIFFED_REPORT, OPEN_REPORT],
  total: 2,
};

export const APPROVED: DriftDecisionResponse = {
  report: { ...DIFFED_REPORT, status: 'approved', approvedBy: USER_ID, resolvedAt: NOW },
  newMemoryVersionId: CANDIDATE_VERSION_ID,
  aliasMigration: { migrated: 33, dropped: 7, rate: 0.825 },
};

export const REJECTED: DriftDecisionResponse = {
  report: { ...DIFFED_REPORT, status: 'rejected', approvedBy: USER_ID, resolvedAt: NOW },
  newMemoryVersionId: null,
  aliasMigration: null,
};

const SCOPED_QUERY = {
  verb: 'filter' as const,
  targetPhrase: 'only the pending ones',
  constraints: [{ kind: 'within' as const, landmark: 'region:orders' }],
  stateFingerprint: HASH_C,
  candidateElementKeys: ['orders.filter.pending', 'orders.filter.approved'],
};

const RESOLUTION_RESULT = {
  outcome: 'resolved' as const,
  elementId: REPORT_ID,
  elementKey: 'orders.filter.pending',
  confidence: 0.97,
  tier: 'T0' as const,
  latencyMs: 4,
  candidates: [
    {
      elementId: REPORT_ID,
      elementKey: 'orders.filter.pending',
      label: 'Pending',
      confidence: 0.97,
      signalScores: { role: 0.2, accessible_name: 0.08 },
    },
  ],
};

export const EVIDENCE_KEY = 'tenants/3f2504e0/sessions/9c5b94b1/step-4.png';

export const SESSION_STEP: SessionStep = {
  id: REPORT_ID,
  sessionId: SESSION_ID,
  ordinal: 4,
  utterance: 'show me only the pending ones',
  intent: SCOPED_QUERY,
  resolution: RESOLUTION_RESULT,
  elementId: APPLICATION_ID,
  tier: 'T0',
  confidence: 0.97,
  actionClass: 'R',
  latencyMs: 312,
  outcome: 'executed',
  evidence: [
    {
      kind: 'screenshot',
      storageKey: EVIDENCE_KEY,
      contentHash: HASH_B,
      capturedAt: NOW,
    },
  ],
  createdAt: NOW,
};

export const SESSION_TIMELINE: SessionTimeline = {
  session: {
    id: SESSION_ID,
    tenantId: TENANT_ID,
    applicationId: APPLICATION_ID,
    memoryVersionId: MEMORY_VERSION_ID,
    userId: USER_ID,
    startedAt: EARLIER,
    endedAt: NOW,
  },
  steps: [SESSION_STEP],
  evidence: [
    {
      storageKey: EVIDENCE_KEY,
      url: 'https://evidence.wisprtest.example/tenants/3f2504e0/step-4.png?sig=abc',
      expiresAt: NOW,
    },
  ],
};

/** An open false-execution report against `SESSION_STEP` (ordinal 4). */
export const OPEN_FALSE_EXECUTION: FalseExecutionReport = {
  id: 'c56a4180-65aa-42ec-a945-5fd21dec0539',
  sessionId: SESSION_ID,
  stepOrdinal: 4,
  reason: 'wrong_element',
  expectedElementId: null,
  note: 'approved the row above the one I named',
  status: 'open',
  reportedBy: USER_ID,
  reportedAt: NOW,
  withdrawnBy: null,
  withdrawnAt: null,
  withdrawnReason: null,
};

/** The same report, retracted. Kept rather than deleted, so a retraction stays visible. */
export const WITHDRAWN_FALSE_EXECUTION: FalseExecutionReport = {
  ...OPEN_FALSE_EXECUTION,
  status: 'withdrawn',
  withdrawnBy: USER_ID,
  withdrawnAt: NOW,
  withdrawnReason: 'filed against the wrong step',
};
