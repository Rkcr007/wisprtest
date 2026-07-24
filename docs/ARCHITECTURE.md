# WisprTest — Architecture

Read alongside `CLAUDE.md`. This document is the map: what exists, what talks to what,
and what each piece owns. If you are about to create a module, find it here first.

---

## 1. System map

```
┌──────────────────────────── TESTER'S BROWSER ─────────────────────────────┐
│                                                                            │
│  Application under test (customer's app, untouched)                        │
│                                                                            │
│  ┌──────────────── EXTENSION (MV3) — the hot path ─────────────────────┐  │
│  │                                                                      │  │
│  │  content script                          service worker              │  │
│  │  ├─ RuntimeStateEngine   ──────────────► MemoryClient (Redis-backed) │  │
│  │  ├─ ElementIndex (scoped)                ├─ snapshot cache           │  │
│  │  ├─ Resolver (T0 → T1 → T2) ────────────►└─ alias write-back queue   │  │
│  │  ├─ SpeculationController                                            │  │
│  │  ├─ ActionExecutor (CDP)                 offscreen document          │  │
│  │  └─ HUD (React, shadow DOM)              └─ VoicePipeline (ASR WS)   │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │ HTTPS / WSS (never in the hot path)
┌────────────────────────────────────▼───────────────────────────────────────┐
│                              CONTROL PLANE                                  │
│                                                                             │
│  gateway (Fastify)                                                          │
│  ├─ auth (OIDC), tenancy, RBAC, rate limit, audit                          │
│  ├─ /memory      snapshot read, alias write-back                            │
│  ├─ /sessions    step ingest, replay                                        │
│  ├─ /seed        composition + materialization orchestration                │
│  └─ /jobs        index / relearn queue                                      │
│                                                                             │
│  indexer (Node + Playwright)          composer (FastAPI)                    │
│  ├─ RouteCrawler                      ├─ SchemaInference                    │
│  ├─ ElementExtractor ─┐               ├─ ConstraintParser                   │
│  ├─ NetworkObserver   ├─ shares       ├─ ConstraintSolver                   │
│  ├─ SchemaObserver    │  packages/    ├─ ValueSampler                       │
│  └─ DriftReconciler ──┘  fingerprint  └─ ProvenanceBuilder                  │
│                                                                             │
│  console (Next.js) — connect, indexing, memory, sessions, seeded data       │
└─────────────┬──────────────────┬───────────────────┬────────────────────────┘
              │                  │                   │
        PostgreSQL 16         Qdrant              Redis
        memory graph          element vectors     hot snapshots
        schemas               alias corpus        runtime cache
        seed ledger
        sessions / audit
```

---

## 2. Package boundaries

### `packages/protocol` — the contract

Zod schemas for every cross-boundary payload. TypeScript types are **derived**
(`z.infer`), never hand-written. The composer's pydantic models are generated from the
same JSON Schema export so Python and TypeScript cannot drift.

Owns: `ElementFingerprint`, `ScreenNode`, `NavEdge`, `MemorySnapshot`, `Intent`,
`ResolutionResult`, `ActionRequest`, `EntitySchema`, `FieldSpec`, `ConstraintSet`,
`CompositionPlan`, `ProvenanceEntry`, `SeedLedgerEntry`, `SessionStep`, `DriftReport`.

Nothing else defines these shapes. Ever.

### `packages/fingerprint` — shared resolution logic

Pure functions, zero DOM-library dependencies beyond the standard DOM API so it runs in
both the extension and Playwright.

```ts
computeFingerprint(el: Element, ctx: PageContext): ElementFingerprint
scoreCandidate(fp: ElementFingerprint, live: Element): number   // 0..1
resolve(query: ScopedQuery, candidates: Element[]): ResolutionResult
structuralHash(root: Element): string                            // drift detection
```

**Fingerprint signals and weights** (weights are config, tuned per corpus, not constants
scattered in code):

| Signal | Weight | Notes |
|--------|--------|-------|
| Computed ARIA role | 0.20 | Stable across restyles |
| Accessible name (normalised, PII-scrubbed) | 0.25 | Highest single signal |
| Landmark / section ancestry path | 0.15 | Survives sibling churn |
| Stable attributes (`data-testid`, `name`, non-generated `id`) | 0.20 | When present, near-decisive |
| Ordinal within parent group | 0.08 | Breaks ties in lists |
| Text shingle hash | 0.07 | Content-derived, weakest |
| Viewport-normalised bbox | 0.05 | Last resort |

Never XPath. Never a single CSS selector. Resolution is a weighted score with a
threshold; below threshold it escalates rather than guesses.

### `packages/ui` — design system

Tokens (the amber/mint/violet/blue semantic palette), HUD primitives, `useDraggable`,
reticle, ghost cursor. Consumed by both the extension HUD and the console so they
cannot drift visually.

---

## 3. Extension internals

### RuntimeStateEngine

Derives a state vector from observable streams — never polling.

```ts
type RuntimeState = {
  route: string;            // History API interception
  routePattern: string;     // /orders/:id
  modalStack: string[];     // dialog role tracking
  focusedLandmark: string;  // activeElement's nearest landmark
  visibleSet: Set<Element>; // IntersectionObserver
  structuralHash: string;   // computed on route settle
  stateFingerprint: string; // hash(routePattern, modalStack, focusedLandmark)
};
```

Sources: `MutationObserver` (debounced 50ms), `IntersectionObserver`, History API patch,
`focusin`. `stateFingerprint` is the cache key for scoped resolution and the drift
detection key.

### Resolver — the three tiers

```
utterance ──► IntentParser ──► ScopedQuery { verb, targetPhrase, constraints }
                                    │
                     scope = visibleSet ∩ reachableSet   (dozens, not thousands)
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
   T0 alias map               T1 embedding kNN            T2 LLM w/ candidates
   Map<phrase, elementId>     ONNX bge-small, quantized   Haiku-class, JSON out
   < 15 ms                    < 40 ms                     < 800 ms
        │                           │                           │
        └───────────────────────────┴───────────────────────────┘
                                    │
                          ResolutionResult { elementId, confidence, tier }
                                    │
                        confidence ≥ τ ?  ──no──► disambiguation UI (ordinals)
                                    │yes
                                    ▼
                       SpeculationController (class R/C/A/S)
```

T1 and T2 results are enqueued for alias write-back. The write-back is **per tenant per
app version** — structural learning may be shared across tenants, vocabulary may not.

### SpeculationController

```ts
onPartialHypothesis(h) {
  const res = resolve(h);
  if (res.confidence < τ) return stage(res);          // class A: reticle only
  if (classify(res.action) !== 'R') return stage(res); // C/S: reticle, no execute
  execute(res);                                        // R: speculative, rollback-able
}
onRevisedHypothesis(h) { rollbackIfDiverged(h); }
onFinalTranscript(h)   { commit(h); }
```

Rollback applies only to class R. That is the entire reason the taxonomy exists.

### ActionExecutor

Dispatches trusted events via CDP (`Input.dispatchKeyEvent`, `Input.dispatchMouseEvent`)
rather than synthetic DOM events, so apps that check `isTrusted` behave correctly.
Emits a `SessionStep` for every action with tier, latency, confidence, and evidence refs.

---

## 4. Data model (PostgreSQL)

```sql
-- Tenancy
tenants(id, name, created_at)
users(id, tenant_id, email, role, created_at)              -- role: owner|lead|tester|viewer

-- Applications and memory
applications(id, tenant_id, name, base_url, env, created_at)
memory_versions(id, application_id, version, status, created_at, approved_by)
                                                            -- status: building|active|superseded
screens(id, memory_version_id, route_pattern, state_fingerprint, label, structural_hash)
elements(id, screen_id, element_key, role, accessible_name_hash,
         fingerprint jsonb, confidence numeric, stability numeric)
nav_edges(id, memory_version_id, from_screen, to_screen, trigger_element, preconditions jsonb)
aliases(id, tenant_id, memory_version_id, phrase, element_id, source, hits, created_at)
                                                            -- source: indexed|t2_writeback|manual

-- Entity schemas (per application — this is the test data foundation)
entity_schemas(id, memory_version_id, entity_name, observed_count, confidence, created_at)
field_specs(id, entity_schema_id, name, type, required, derived_rule,
            enum_values jsonb, distribution jsonb, references_entity)
materializers(id, entity_schema_id, kind, spec jsonb, priority, verified_at)
                                                            -- kind: api|ui|fixture

-- Seeding
seed_ledger(id, tenant_id, session_id, entity_schema_id, external_ref,
            adapter_used, payload jsonb, provenance jsonb,
            inverse_op jsonb, created_at, reverted_at)

-- Sessions
sessions(id, tenant_id, application_id, memory_version_id, user_id, started_at, ended_at)
session_steps(id, session_id, ordinal, utterance, intent jsonb, element_id,
              tier, confidence, latency_ms, outcome, evidence jsonb)

-- Governance
drift_reports(id, memory_version_id, screen_id, diff jsonb, status, approved_by, created_at)
audit_log(id, tenant_id, actor, action, target, metadata jsonb, created_at)
```

Every table carries `tenant_id` directly or via an owning row. Row-level security
policies enforce it at the database, not only in application code.

---

## 5. Service responsibilities

### gateway (Fastify)

| Route | Purpose |
|-------|---------|
| `POST /v1/applications` | Register an app, kick off indexing |
| `GET /v1/memory/:appId/snapshot` | Compressed snapshot for extension boot |
| `POST /v1/memory/aliases` | T2 write-back (batched, per tenant) |
| `POST /v1/seed/plan` | utterance + state → CompositionPlan (no writes) |
| `POST /v1/seed/execute` | Approved plan → materialize + ledger entry |
| `POST /v1/seed/revert` | Revert one entry or a whole session |
| `POST /v1/sessions/:id/steps` | Batched step ingest |
| `GET /v1/drift/:appId` | Pending drift reports |
| `POST /v1/drift/:id/approve` | Human approval of a memory mutation |

Owns auth (OIDC), tenant scoping, RBAC, rate limiting, audit. Never contains business
logic for composition or crawling — it orchestrates.

### indexer (Node + Playwright)

Consumes jobs from a Redis stream. Per route: navigate, settle, extract elements via
`packages/fingerprint`, compute structural hash, capture forms, observe network traffic
for entity shapes, derive nav edges. Writes a new `memory_version` with status
`building`, flips to `active` on completion.

Crawl is bounded by an allowlist, a depth cap, and a rate limit. It respects a
per-application "do not touch" selector list so it never clicks Delete during a crawl.

### composer (FastAPI)

Stateless. Takes `(entity_schema, constraints, runtime_state)` and returns a
`CompositionPlan` with per-field provenance. Does not write anything. Materialization is
the gateway's job. Detailed in `docs/TEST-DATA-ENGINE.md`.

---

## 6. The three long-running loops

**1. Runtime loop** (milliseconds, in-extension)
`speech → partial hypothesis → scoped resolve → speculate/stage → commit → execute → state update → session step`

**2. Learning loop** (background, minutes)
`structural hash mismatch → drift report → indexer reconciles changed region → diff → human approval → memory version increment → alias migration → snapshot invalidation`

**3. Compounding loop** (continuous, the moat)
`T2 escalation → successful resolution → alias write-back → next occurrence is T0`

Instrument all three. Tier distribution over time is the single best health metric for
the product: if T0 share is not climbing, the compounding loop is broken.

---

## 7. Observability contract

Every service emits:

- **Traces** — OTel spans across the full command lifecycle. Span attributes:
  `tenant_id`, `app_id`, `memory_version`, `tier`, `action_class`, `confidence`.
- **Metrics** —
  `wispr_resolution_latency_ms{tier}` (histogram),
  `wispr_tier_total{tier}` (counter),
  `wispr_false_execution_total` (counter — alerts at any nonzero rate),
  `wispr_speech_to_reticle_ms` (histogram),
  `wispr_seed_plan_latency_ms`, `wispr_seed_materialize_total{adapter,outcome}`,
  `wispr_drift_open_total`, `wispr_memory_staleness_hours`.
- **Logs** — structured JSON, `tenant_id`/`session_id`/`trace_id` on every line.
  Element text content is never logged.
- **Health** — `/healthz` (liveness), `/readyz` (dependencies checked).

---

## 8. Security model

- **Tenant isolation** — Postgres RLS, Redis key namespacing, Qdrant per-tenant collections.
- **Auth** — OIDC for console; extension holds a short-lived scoped token refreshed by the service worker.
- **Credentials for the app under test** — never stored by WisprTest in plaintext. Auth profiles hold a reference to the customer's secret manager, or the tester supplies them per session.
- **SSRF** — indexer targets are allowlisted per application; no user-supplied URL reaches the crawler unvalidated.
- **PII** — redaction runs before persistence and before any LLM call. Accessible names are stored hashed plus a scrubbed display form.
- **Seeding blast radius** — materializers are environment-scoped. Production environments default to seeding disabled and require an explicit, audited opt-in.
- **Audit** — every memory mutation, seed, revert, and approval is written to `audit_log`.

---

## 9. Deployment

Each service is a container with a Helm chart. Extension ships through the Chrome Web
Store (or enterprise force-install policy). Postgres, Redis, and Qdrant are managed
services in production, Compose locally.

`make dev` brings up gateway, composer, indexer, console, and dependencies, and builds
the extension in watch mode for unpacked loading.
