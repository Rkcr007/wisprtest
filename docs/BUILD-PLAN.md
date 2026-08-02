# WisprTest — Build Plan

Exact prompts, in order.

Everything in a `PROMPT` block is copy-paste verbatim. Do not paraphrase them — they are
written to be unambiguous and to reference the contract files rather than restate them.

---

## How to run a session

> **Scheduling changed after Phase 14.** The rule below — one phase per session, worked
> through in order — is how Phases 0–14 were built. It has been replaced by
> `CLAUDE.md § "Parallel tracks"`: the unit of work is now a track (one owner, one module,
> one branch, one PR), several run concurrently, and nothing merges without CI green. See
> [ADR 0012](adr/0012-parallel-tracks.md) for why, and what it cost.
>
> **The phase prompts below are unchanged and remain authoritative** for *what* each phase
> must deliver and for its `Done when` command. Only the scheduling around them moved.

**The rule that saves the most time:** context lives in files, not in your messages.
`CLAUDE.md` and `docs/*` are re-read every session. If you find yourself re-explaining
something in chat for the second time, stop and put it in a file instead.

**One phase per session** *(Phases 0–14; superseded by the track protocol above)*. Start a
new session for the next phase. Long sessions accumulate context that makes the model
conservative and repetitive — the reasoning that survives into the track model.

**Ask for a plan first on anything large.** Every prompt below already does this where
it matters.

**Commit at the end of every phase.** `git commit` is your rollback. When a phase goes
sideways, `git reset --hard` and re-run the prompt with one added constraint — that is
almost always faster than patching a bad result.

**Never accept a stub.** If the output contains `TODO`, a mock return, or "you can
implement this later", reject it immediately with the recovery prompt at the bottom of
this document. Accepting one stub teaches the session that stubs are acceptable and you
will get ten more.

---

## Phase 0 — Repository scaffold

**Depends on:** nothing
**Touches:** repo root, tooling

```text
Read CLAUDE.md fully before writing anything.

Create the monorepo scaffold exactly as laid out in CLAUDE.md § "Repository layout".
Nothing else — no features, no business logic.

Deliver:
- pnpm workspace with packages/{protocol,fingerprint,ui} and apps/{extension,console,gateway,indexer,composer}
- TypeScript strict config shared via a base tsconfig, extended by each TS package
- apps/composer as a Python project using uv, with mypy --strict and ruff configured
- ESLint + Prettier for TS, ruff format for Python, both wired to a single `pnpm lint`
- Vitest configured for every TS package; pytest for composer
- docker-compose.yml with postgres:16, redis:7, qdrant:latest, each with healthchecks
- Makefile with: dev, build, test, lint, typecheck, db-up, db-migrate
- .env.example listing every variable each service needs, with comments
- .gitignore, .editorconfig, .nvmrc

Each app gets a minimal entrypoint that boots, logs one structured startup line, and
exits cleanly on SIGTERM. No placeholder route handlers.

Show me the plan before creating files.
```

**Done when:**
```bash
pnpm install && pnpm typecheck && pnpm lint && make db-up && docker compose ps
```

**Do not build:** any feature code, any schema, any UI.

---

## Phase 1 — Protocol package (the contract)

**Depends on:** 0
**Touches:** `packages/protocol/**`

```text
Read CLAUDE.md and docs/ARCHITECTURE.md § 2 and § 4.

Implement packages/protocol. This is the single source of truth for every payload that
crosses a process boundary. Everything downstream depends on it, so get it complete now.

Define Zod schemas, and derive TypeScript types with z.infer, for:

Memory:      ElementFingerprint, ScreenNode, NavEdge, MemorySnapshot, MemoryVersion
Resolution:  ScopedQuery, ResolutionResult, Tier ("T0"|"T1"|"T2"), Alias
Runtime:     RuntimeState, StateFingerprint, ActionClass ("R"|"C"|"A"|"S"),
             ActionRequest, ActionResult, SessionStep
Data:        EntitySchema, FieldSpec, Constraint, ConstraintSet, CompositionPlan,
             ProvenanceEntry, MaterializationResult, InverseOperation, SeedLedgerEntry
Drift:       DriftReport, StructuralDiff
Errors:      a discriminated union WisprError with codes, plus a Result<T> helper type

Requirements:
- ActionClass values and their meaning must match CLAUDE.md § "Reversibility taxonomy"
  exactly. Add a doc comment on the type restating the table.
- Export a JSON Schema bundle via zod-to-json-schema at packages/protocol/dist/schema.json
- Add a script `pnpm --filter protocol gen:python` that generates pydantic v2 models from
  that JSON Schema into apps/composer/src/composer/protocol/ so Python and TS cannot drift.
  Wire it into `make build`.
- Every schema gets a round-trip unit test with at least one valid and one invalid fixture.

No implementation logic in this package. Types and schemas only.
```

**Done when:**
```bash
pnpm --filter protocol test && pnpm --filter protocol gen:python && cd apps/composer && uv run mypy --strict src
```

**Do not build:** resolvers, services, anything that consumes these types yet.

---

## Phase 2 — Fingerprint package

**Depends on:** 1
**Touches:** `packages/fingerprint/**`

```text
Read CLAUDE.md and docs/ARCHITECTURE.md § 2 (fingerprint signals table).

Implement packages/fingerprint. This code runs in BOTH the browser extension and the
Playwright indexer, so it may use only standard DOM APIs — no framework, no browser-only
globals beyond document/window, no Node-only APIs.

Public API:
  computeFingerprint(el: Element, ctx: PageContext): ElementFingerprint
  scoreCandidate(fp: ElementFingerprint, live: Element): number   // 0..1
  resolve(query: ScopedQuery, candidates: Element[]): ResolutionResult
  structuralHash(root: Element): string

Implement all seven signals from the ARCHITECTURE table with the stated weights. Weights
must live in an exported, overridable config object — not as inline constants.

Specific requirements:
- Accessible name computation follows the ARIA accname algorithm for the common cases
  (aria-label, aria-labelledby, label[for], placeholder, text content). Do not pull in a
  heavy dependency; implement the subset and document what is not covered.
- Every accessible name passes through a redact(text) hook before it is stored or
  returned, per CLAUDE.md § "PII rule". Provide a default redactor that masks emails,
  phone numbers, long digit runs, and currency amounts.
- Attributes are only treated as stable if they do not look framework-generated. Reject
  ids matching common generated patterns (e.g. hashes, :r1:, ember123, css-modules
  suffixes). Document the heuristics.
- resolve() returns confidence and never picks below the threshold — it returns a
  ranked candidate list for disambiguation instead.
- structuralHash ignores text content and volatile attributes so it detects layout and
  component changes, not data changes.

Tests: build fixture DOMs with happy-dom covering — exact match, renamed button,
moved element, reordered list, framework-regenerated ids, ambiguous duplicates,
and a full re-render where only structure changed. Assert scores and tier decisions,
not just "it returned something".
```

**Done when:**
```bash
pnpm --filter fingerprint test -- --coverage   # ≥90% on scoring + resolve
```

**Do not build:** anything that stores fingerprints, any network code.

---

## Phase 3 — Database schema

**Depends on:** 1
**Touches:** `db/**`

```text
Read docs/ARCHITECTURE.md § 4 (data model) and CLAUDE.md § "Non-negotiable rules" #7.

Implement the full PostgreSQL schema in db/migrations using Atlas (declarative HCL or
versioned SQL — pick one and be consistent).

Cover every table in ARCHITECTURE § 4. In addition:
- Row-level security policies on every tenant-scoped table, enforced at the database.
  Include a test that proves a session set to tenant A cannot read tenant B's rows.
- Indexes for the actual query patterns: memory snapshot load by (application_id, version),
  alias lookup by (tenant_id, memory_version_id, phrase), ledger by session_id,
  session_steps by (session_id, ordinal).
- Foreign keys with explicit ON DELETE behaviour — no defaults left implicit.
- CHECK constraints for every enum-like column.
- updated_at triggers where mutation is expected.
- A seed fixture (db/seed/) with one tenant, two users of different roles, and one
  application, used by integration tests.

Provide `make db-migrate` and `make db-reset`. Write the RLS test as a real integration
test that runs against the compose postgres.
```

**Done when:**
```bash
make db-reset && make db-migrate && pnpm --filter gateway test:db
```

**Do not build:** ORM models or repositories yet.

---

## Phase 4 — Gateway skeleton

**Depends on:** 1, 3
**Touches:** `apps/gateway/**`

```text
Read CLAUDE.md and docs/ARCHITECTURE.md § 5 and § 7.

Build apps/gateway as a Fastify service. This phase is infrastructure only — auth,
tenancy, observability, and repository layer. No product endpoints yet.

Deliver:
- Config loaded from env and validated with Zod at boot. Boot fails loudly and
  specifically on a missing or invalid variable. No silent defaults.
- OIDC authentication; JWT verification with JWKS caching and rotation handling.
- Tenant context propagated via AsyncLocalStorage. Every DB connection sets the RLS
  session variable from that context — make it impossible to query without a tenant.
- RBAC middleware with the four roles from the data model (owner, lead, tester, viewer)
  and a declarative permission map.
- Repository layer over the Phase 3 schema using Kysely, with types generated from the
  live database (kysely-codegen) wired into `make build`.
- Rate limiting per tenant, backed by Redis.
- OpenTelemetry: traces, plus the metrics named in ARCHITECTURE § 7 that apply to gateway.
- Structured logging with pino; every line carries tenant_id, session_id, trace_id.
  Add a redaction serialiser so element text can never be logged.
- /healthz and /readyz — readyz actually checks postgres, redis and qdrant.
- Typed error taxonomy mapped to HTTP status codes via a single error handler.
- Graceful shutdown: stop accepting, drain in-flight, close pools.

Integration tests must run against the compose stack, not mocks.
```

**Done when:**
```bash
pnpm --filter gateway test && curl -sf localhost:8080/readyz
```

**Do not build:** memory, seed, or session endpoints.

---

## Phase 5 — Indexer: crawl and build memory

**Depends on:** 2, 3, 4
**Touches:** `apps/indexer/**`

```text
Read CLAUDE.md, docs/ARCHITECTURE.md § 5 (indexer), and packages/fingerprint's API.

Build apps/indexer: a Node worker using Playwright that consumes crawl jobs from a Redis
stream and produces a complete memory_version.

Per job:
1. Launch a browser context. Apply the application's auth profile (see below).
2. BFS crawl from base_url, bounded by: route allowlist, depth cap, page cap, and a
   per-application "never interact" selector list so a crawl can never click a destructive
   control. These bounds are config, and the crawl must refuse to start without them.
3. Per route: wait for network idle plus a settle delay, then
   - extract every interactive element via packages/fingerprint.computeFingerprint
   - compute structuralHash for the route
   - derive a route_pattern by generalising ids in the URL (/orders/1841 → /orders/:id)
   - record nav edges by observing which element click produced which route transition
4. Write screens, elements and nav_edges under a new memory_version with status
   'building'; flip to 'active' on success, 'failed' with a reason on error.
5. Emit progress events to Redis so the console can stream them live.

Auth profiles: support (a) form login with credentials fetched from the tenant's
configured secret reference, and (b) a storageState blob captured by the tester. Never
persist raw credentials — CLAUDE.md § "PII rule" and ARCHITECTURE § 8.

SSRF: validate every target URL against the application's allowlist before navigation.
Reject private IP ranges and non-http(s) schemes.

Resumability: a crashed job restarts from the last completed route, not from scratch.

Test against a small fixture app you create at apps/indexer/test/fixture-app (a real
Express + HTML app with 5 routes, a form, and a table — not a mock). Assert the produced
memory_version has the expected screens, elements and edges.
```

**Done when:**
```bash
pnpm --filter indexer test:e2e   # crawls the fixture app, asserts memory contents
```

**Do not build:** schema observation or network observation — that is Phase 13.

---

## Phase 6 — Extension shell and HUD

**Depends on:** 1, 2
**Touches:** `apps/extension/**`, `packages/ui/**`

```text
Read CLAUDE.md and docs/ARCHITECTURE.md § 3.

Build the MV3 extension shell and the floating HUD. No voice, no resolution yet — this
phase proves the extension can attach to a page and render the HUD without disturbing it.

packages/ui first:
- Design tokens as CSS custom properties matching the prototype palette:
  signal #FFB454 (listening/aiming), commit #52E0AC (executed), seed #C88BFF
  (generated data), memory #7FA8FF (stored knowledge), drift #FF6B4A.
  Each token gets a doc comment stating its semantic meaning — these are not decorative.
- useDraggable hook: pointer-capture based, writes transform directly during drag and
  commits to state on release, magnets to all four viewport edges, re-clamps on resize.
- Primitives: Reticle (four corner brackets, spring easing), GhostCursor, VadBars, Chip,
  Cell, Toast.
- Full keyboard accessibility and prefers-reduced-motion support throughout.

apps/extension:
- MV3 manifest with the minimum permissions actually required. Justify each in a comment.
- Content script mounting the HUD inside a shadow DOM with adopted stylesheets, so the
  host page's CSS cannot leak in and ours cannot leak out.
- The HUD must never modify host page layout, steal focus, or intercept host events
  outside its own bounds. Add a test asserting host document.body styles are unchanged
  after mount.
- Service worker with a scoped-token lifecycle against the gateway (refresh, retry,
  fail closed).
- HUD renders three bands: grip + orb + VAD + transcript + state; intent band;
  telemetry band. Collapsible. Draggable by the grip.
- Attach state machine: detached → attaching → attached, surfaced in the HUD.

Show me the plan before writing code.
```

**Done when:**
```bash
pnpm --filter extension build && pnpm --filter extension test:e2e   # Playwright loads unpacked ext, asserts HUD mounts and drags
```

**Do not build:** voice, resolution, execution.

---

## Phase 7 — Runtime state engine

**Depends on:** 6
**Touches:** `apps/extension/src/runtime/**`

```text
Read docs/ARCHITECTURE.md § 3 (RuntimeStateEngine).

Implement RuntimeStateEngine in the content script. It derives RuntimeState from
observable streams — never polling, never setInterval.

Sources:
- History API interception (pushState/replaceState/popstate) for route
- MutationObserver, debounced 50ms with a leading edge, for structural change
- IntersectionObserver for the visible set
- focusin for focusedLandmark
- dialog/aria-modal tracking for modalStack

Outputs, per docs/ARCHITECTURE § 3:
- route, routePattern, modalStack, focusedLandmark, visibleSet, structuralHash,
  stateFingerprint

Also implement ScopedElementIndex: given RuntimeState, produce the candidate set of
elements that are currently visible AND reachable. This is the set the resolver will
search. It must be recomputed incrementally on mutation, not rebuilt from scratch.

Performance requirement: recomputing the scoped index after a mutation burst must stay
under 8ms on a page with 3000 DOM nodes. Write a benchmark test that asserts this and
fails the build if it regresses.

Expose the state as an observable other modules subscribe to. No global mutable state.
```

**Done when:**
```bash
pnpm --filter extension test:runtime && pnpm --filter extension bench:scope
```

**Do not build:** resolution or voice.

---

## Phase 8 — Memory snapshot + T0/T1 resolution

**Depends on:** 2, 5, 7
**Touches:** `apps/extension/src/resolver/**`, `apps/gateway/src/routes/memory.ts`

```text
Read docs/ARCHITECTURE.md § 3 (Resolver) and CLAUDE.md § "Resolution tiers".

Two parts.

Gateway:
- GET /v1/memory/:appId/snapshot returns a compressed MemorySnapshot for the active
  memory_version: screens, elements, nav edges, aliases. Cached in Redis, keyed by
  (tenant, app, version), invalidated on version change.
- POST /v1/memory/aliases accepts a batch of alias write-backs, scoped to tenant and
  memory_version. Dedupe on (memory_version_id, phrase); increment hits on conflict.

Extension:
- MemoryClient in the service worker: fetch snapshot on attach, hold in memory, expose
  to the content script via a typed message channel. Handle version mismatch by refetching.
- T0 resolver: exact and alias match over the scoped candidate set. Must resolve in
  under 15ms at p99 with 500 aliases loaded — benchmark it.
- T1 resolver: local embedding kNN. Ship a quantized bge-small ONNX model bundled with
  the extension and run it via onnxruntime-web with the WASM backend. Embed only the
  scoped candidates' accessible names, cached per stateFingerprint so repeat lookups on
  the same screen are free. Budget 40ms.
- A single resolve(utterance) entry point that tries T0, then T1, and returns
  ResolutionResult with tier and confidence. Below threshold, return ranked candidates
  for disambiguation rather than picking.

Do NOT implement T2 in this phase.

Test with the Phase 5 fixture app: index it, load the snapshot, assert that a set of
~20 natural phrasings resolve to the correct elements at the expected tiers.
```

**Done when:**
```bash
pnpm --filter gateway test:memory && pnpm --filter extension test:resolver && pnpm --filter extension bench:resolve
```

**Do not build:** T2, voice, execution.

---

## Phase 9 — Voice pipeline

**Depends on:** 6
**Touches:** `apps/extension/src/voice/**`

```text
Read CLAUDE.md § "Performance budgets" and docs/ARCHITECTURE.md § 3.

Implement the voice pipeline in an MV3 offscreen document (getUserMedia is unavailable
in the service worker).

Requirements:
- Push-to-talk on a configurable modifier key, held. Not a wake word — testers work in
  open offices. Also support a toggle mode behind a setting.
- Capture at 16kHz mono, frame the audio, run WebRTC VAD to gate transmission.
- Stream to a streaming ASR provider over WebSocket. Abstract the provider behind a
  StreamingAsr interface with a Deepgram implementation first; the interface must make a
  second provider a drop-in.
- Emit PartialHypothesis events as they arrive, and a FinalTranscript on endpoint.
  Partial hypotheses must be emitted with their own monotonic revision number so
  downstream consumers can detect a revision.
- Reconnect with exponential backoff. Buffer audio during reconnect up to 3s, then drop
  with a visible HUD state — never silently lose audio.
- Emit wispr_speech_to_partial_ms as a metric.
- Never persist raw audio. Transcripts are held in memory for the session only.

The HUD consumes PartialHypothesis to render the live transcript with the unconfirmed
tail visually distinguished.

Write tests using a recorded audio fixture and a fake StreamingAsr that replays a
scripted sequence of partials including at least one revision, so downstream phases have
a deterministic harness.
```

**Done when:**
```bash
pnpm --filter extension test:voice
```

**Do not build:** intent parsing, speculation.

---

## Phase 10 — Speculation, reticle, execution

**Depends on:** 8, 9
**Touches:** `apps/extension/src/speculation/**`, `apps/extension/src/executor/**`

```text
Read CLAUDE.md § "Reversibility taxonomy" — this phase is where it is enforced. Re-read
it before writing code.

Implement three components.

1. IntentParser: utterance → { verb, targetPhrase, constraints }. Rule-based over the
   learned vocabulary in the memory snapshot; no LLM in this phase. Verbs: navigate,
   click, type, focus, scroll, filter, check, back.

2. SpeculationController, exactly as specified in ARCHITECTURE § 3:
   - On each partial hypothesis, resolve against the scoped index
   - Classify the resulting action as R / C / A / S
   - Class R above threshold: execute speculatively, keep a rollback record
   - Class C, S, or below threshold: render the reticle only, never execute
   - On a revised hypothesis that diverges: roll back class R effects
   - On final transcript: commit
   - Class C requires final transcript PLUS a 150ms stability window PLUS explicit
     confirmation before executing

   Write an explicit test that a class C action is NEVER executed from a partial
   hypothesis, including the case where the partial and final transcripts are identical.
   This test is a release gate.

3. ActionExecutor: dispatch via CDP (Input.dispatchMouseEvent / dispatchKeyEvent) so
   host apps that check isTrusted behave correctly. Support click, type (with realistic
   inter-key delay), focus, scroll, select. Every action emits a SessionStep with tier,
   latency, confidence, action class and evidence references.

The reticle must render within 400ms of speech onset at p95 — add a test that measures
this against the scripted ASR fixture from Phase 9 and fails the build on regression.
```

**Done when:**
```bash
pnpm --filter extension test:speculation && pnpm --filter extension test:e2e:command && pnpm --filter extension bench:speech-to-reticle
```

**Do not build:** T2, disambiguation UI, sessions API.

---

## Phase 11 — T2 escalation and the write-back loop

**Depends on:** 10
**Touches:** `apps/extension/src/resolver/tier2.ts`, `apps/gateway/src/routes/resolve.ts`

```text
Read CLAUDE.md § "Resolution tiers". The write-back is the point of this phase — a T2
implementation without write-back is a slower competitor, not a product.

Gateway:
- POST /v1/resolve/escalate takes { utterance, scopedCandidates[], stateFingerprint }
  and calls a small fast model (Claude Haiku class) with the candidate list in the prompt,
  requesting strict JSON: { elementId, confidence, reasoning }.
- Validate the response against the protocol schema. On invalid JSON, retry once with a
  repair instruction, then fail cleanly — never return an unvalidated result.
- Enforce a hard 800ms timeout; on timeout return a typed error so the extension falls
  back to disambiguation rather than hanging.
- Model access goes through a provider abstraction with a configured fallback model.
- Candidate accessible names are redacted before they enter the prompt. Assert this in a
  test — a customer's data must never reach a model provider.

Extension:
- Escalate to T2 only when T0 and T1 both fall below threshold.
- On a successful T2 resolution ABOVE the confidence threshold, enqueue an alias
  write-back { phrase, elementId, stateFingerprint, source: 't2_writeback' }. Flush the
  queue in batches every 10s and on detach.
- On a T2 resolution below threshold, show the ranked disambiguation UI with spoken
  ordinals ("one, two, or three"). When the tester picks, write that back as an alias too
  — a correction is the highest-quality training signal available.

Add an integration test proving the compounding loop: an unknown phrasing resolves at T2,
the alias is persisted, a fresh snapshot is loaded, and the same phrasing then resolves
at T0.
```

**Done when:**
```bash
pnpm --filter gateway test:resolve && pnpm --filter extension test:tier2 && pnpm --filter extension test:writeback-loop
```

---

## Phase 12 — Sessions

**Depends on:** 10
**Touches:** `apps/gateway/src/routes/sessions.ts`, `apps/extension/src/session/**`

```text
Read docs/ARCHITECTURE.md § 4 (sessions, session_steps).

Gateway:
- POST /v1/sessions to open, PATCH to close.
- POST /v1/sessions/:id/steps for batched step ingest, idempotent on (session_id, ordinal).
- GET /v1/sessions/:id returns the full timeline with evidence references.
- Evidence (screenshots, DOM snapshots) goes to object storage; the DB holds references
  and content hashes. Signed URLs for retrieval, scoped to tenant.

Extension:
- Buffer SessionSteps locally and flush in batches every 5s and on detach.
- Capture evidence on check actions and on any failure: screenshot of the target region
  plus a serialised DOM snapshot of the containing landmark. Redact before upload.
- Survive a service worker restart mid-session without losing buffered steps.

Sessions are immutable once closed. Enforce it in the API, not just the UI.
```

**Done when:**
```bash
pnpm --filter gateway test:sessions && pnpm --filter extension test:session-buffer
```

---

## Phase 13 — Schema observation

**Depends on:** 5
**Touches:** `apps/indexer/src/observers/**`

```text
Read docs/TEST-DATA-ENGINE.md § 2 in full. This phase produces the per-application
knowledge that everything in the data engine depends on.

Extend the indexer with three observers. All code is generic; all output is per-app data.

1. FormObserver — per route, extract every form and form-like region. Per control capture
   accessible name, input type, required, pattern, min/max/maxlength, select options, and
   the element fingerprint. Emit a candidate EntitySchema plus a UI materializer
   descriptor { kind:'ui', form, route }.

2. NetworkObserver — record request/response pairs during the crawl.
   - A POST whose payload keys align with an observed form yields an API materializer
     candidate { kind:'api', method, path, payloadTemplate, auth } marked unverified.
   - GET list responses yield value distributions, enum vocabularies, and observed ranges
     per field, computed from real data.
   - Detect referential relationships by matching foreign-key-shaped values across
     entity collections; write them into field_specs.references_entity.

3. DerivedRuleObserver — over observed records, test a SMALL and EXPLICIT hypothesis set:
   sum of a repeated group, count, min, max, date offset from another date, string
   concatenation. Record a rule only when it holds for every observed record, with the
   sample size as confidence. This is not a program synthesiser and must not become one.

Consolidate observations into entity_schemas / field_specs / materializers per
docs/ARCHITECTURE § 4, versioned against the memory_version.

PII: field values used to build distributions are aggregated into statistics. Never
persist raw observed values that could contain customer data — store shape, range and
frequency only. Add a test asserting no raw string values from responses are persisted.

Extend the fixture app from Phase 5 with a create form, a list endpoint returning 50
records, and one derived field, so these observers can be tested for real.
```

**Done when:**
```bash
pnpm --filter indexer test:observers   # asserts schema, enums, distributions, derived rule, both materializer kinds
```

**Do not build:** composition or materialization.

---

## Phase 14 — Composer service

**Depends on:** 1, 13
**Touches:** `apps/composer/**`

```text
Read docs/TEST-DATA-ENGINE.md § 3 in full, including the predicate and multi-entity
sections.

Build apps/composer (FastAPI). It is stateless: given an entity schema, a constraint set
and runtime state, it returns a CompositionPlan with per-field provenance. It NEVER
writes to the application under test.

Components:

1. ConstraintParser — utterance → ConstraintSet. Support all five Constraint kinds from
   the protocol package: equals, reference, cardinality, comparison, predicate.
   Match against learned enum vocabularies and field names first; escalate novel phrasing
   to the same model provider used in Phase 11, with the same write-back discipline.

2. ConstraintSolver — in this order:
   a. apply explicit constraints
   b. resolve references against real existing records; only create a new one when the
      utterance demands novelty
   c. fill required-but-unspecified fields from ValueSampler
   d. solve predicate constraints (e.g. overdue ⇒ back-date due_date so the predicate holds)
   e. evaluate derived rules LAST
   Detect unsatisfiable constraint sets and return a typed conflict explaining which two
   constraints collide, in plain language. Never silently drop a constraint.

3. ValueSampler — sample from the application's observed distribution, never faker
   defaults. Numeric fits the observed distribution; enum samples by observed frequency;
   string follows the learned pattern; date is relative to now with a predicate-satisfying
   offset; uniqueness is checked against observed values with bounded resample retries.

4. ProvenanceBuilder — every field gets { value, source, explanation, confidence } with
   source ∈ requested | reference_matched | sampled | derived | predicate_solved | default.
   The explanation is human-readable and specific: "matched from 64 known accounts",
   not "generated".

5. Output a composition GRAPH, not a single record. A plan is a DAG of records with
   dependency ordering. Build for this now — retrofitting multi-entity later is a rewrite.
   "A customer with an overdue invoice" must produce Account → Invoice in that order.

Full type hints, mypy --strict. Pydantic models generated from the protocol package —
do not hand-write them. OTel tracing and the metrics from ARCHITECTURE § 7.

Tests: property-based tests with hypothesis that generated records always satisfy their
constraint set and always validate against their schema.
```

**Done when:**
```bash
cd apps/composer && uv run mypy --strict src && uv run pytest -q
```

**Do not build:** materialization, ledger, UI.

---

## Phase 15 — Seed preview, UI materializer, ledger

**Depends on:** 12, 14
**Touches:** `apps/gateway/src/routes/seed.ts`, `apps/extension/src/seed/**`

```text
Read docs/TEST-DATA-ENGINE.md § 4, § 5 and § 6.

This phase makes the loop real end to end using the UI materializer only — it is always
available and it exercises the app's real validation.

Gateway:
- POST /v1/seed/plan → calls composer, returns a CompositionPlan. Writes nothing.
- POST /v1/seed/execute → takes an approved plan, runs the materializer chain, verifies,
  writes a SeedLedgerEntry with payload, provenance and inverseOp.
- POST /v1/seed/revert → reverts one entry or a whole session, in reverse dependency
  order for multi-entity graphs.
- Environment policy: seeding is blocked in production unless explicitly and auditably
  enabled per application. Enforce in the route, log every attempt.

Materializer interface exactly as in TEST-DATA-ENGINE § 4. Implement the UI adapter:
drives the real create form in a Playwright worker, using packages/fingerprint to resolve
form controls — the same resolver the runtime uses. Verify by asserting the resulting
record is reachable. Derive inverseOp from an indexed delete flow when one exists;
when none exists, set { kind:'none', reason } and surface that in the preview.

Extension:
- Seeding is action class S: never speculative, never silent.
- SeedPreview card renders entity, every field with its value and provenance explanation,
  the record count, WHICH ADAPTER will run, and whether it can be reverted.
- Explicit approval required. Only then call /v1/seed/execute.
- Created records get a distinct visual treatment in the app under test.

The adapter that ran must always be visible to the tester — it changes what the test
actually covered. If the API adapter created the record, client-side validation was never
exercised and they need to know.

Test the full loop against the Phase 13 fixture app: utterance → plan → preview →
approve → record exists → revert → record gone.
```

**Done when:**
```bash
pnpm --filter gateway test:seed && pnpm --filter extension test:e2e:seed
```

---

## Phase 16 — API materializer and fallback chain

**Depends on:** 15
**Touches:** `apps/gateway/src/materializers/**`

```text
Read docs/TEST-DATA-ENGINE.md § 4.

Implement the API and fixture materializers and the full fallback chain:
fixture → api → ui → surface failure with the concrete reason.

API adapter:
- Replay the observed create request with the composed payload.
- Auth reuses the tester's live session from the attached tab. WisprTest never stores the
  application's credentials.
- Verify by issuing the observed read-back request and asserting the record exists.
- On 4xx/5xx: mark the materializer unverified, enqueue re-observation, fall back to UI.
- Materializer verification has a TTL; an unverified-in-N-days API materializer drops
  below UI in priority until re-verified.

Fixture adapter: customer-configured seeding endpoint or command, configured per
application in the console. Highest priority when present and verified.

Never silently degrade. The chosen adapter and the reason for any fallback are recorded
in the ledger entry and shown in the HUD.

Add a chaos test: force the API adapter to fail and assert the chain falls back to UI,
the record is still created, and the ledger records both the attempt and the fallback.
```

**Done when:**
```bash
pnpm --filter gateway test:materializers && pnpm --filter gateway test:fallback-chain
```

---

## Phase 17 — Drift detection and relearn

**Depends on:** 5, 8
**Touches:** `apps/indexer/src/drift/**`, `apps/extension/src/drift/**`, gateway

```text
Read docs/ARCHITECTURE.md § 6 (learning loop) and CLAUDE.md.

Extension:
- On route settle, compute structuralHash and compare against the memory snapshot.
- On mismatch: emit a DriftReport, show a NON-BLOCKING notice, and continue working in
  degraded mode. Never block the tester.

Indexer:
- Consume drift reports and re-crawl only the changed region, not the whole app.
- Produce a StructuralDiff: added, removed, moved, renamed elements, plus any schema
  changes from re-running the Phase 13 observers on that region.
- Attempt alias migration where fingerprints still match above threshold. Report the
  migration rate.

Gateway:
- GET /v1/drift/:appId lists pending reports.
- POST /v1/drift/:id/approve applies the diff, increments memory_version, migrates
  aliases, invalidates the snapshot cache, and flags affected saved flows.

Human approval is REQUIRED before a memory version becomes active. Fully automatic
self-healing is what destroyed trust in the previous generation of QA tools — it made
tests pass that should have failed. WisprTest proposes; a human commits. Do not add an
auto-approve path, even behind a flag.
```

**Done when:**
```bash
pnpm --filter indexer test:drift && pnpm --filter gateway test:drift
```

---

## Phase 18 — Console

**Depends on:** 4, 5, 12, 15, 17
**Touches:** `apps/console/**`

```text
Read CLAUDE.md, docs/ARCHITECTURE.md, and use packages/ui tokens — the console and the
HUD must not drift visually.

Build the Next.js 15 console. Server Components for data fetching, Zustand for client
state, TanStack Query for mutations. shadcn/ui primitives styled with our tokens.

Screens:
- Connect: URL entry with environment selector, plus recently-worked-on applications
  showing memory version, screen and element counts, and index age.
- Indexing: live progress streamed from the indexer — routes, schemas and workflows
  appearing as they are discovered, with counters and a progress bar.
- Application overview: coverage, drift status, recent sessions.
- Product Memory: navigation graph (interactive), element registry with confidence and
  stability, alias/vocabulary manager.
- Data: learned entity schemas with expandable field specs showing type, required,
  derived and enum values; materializer configuration including the fixture adapter;
  seeded records for the session with a revert control.
- Sessions: history, and a detail view with the step timeline and synchronised evidence.
- Drift: pending reports with a reviewable diff and approve/reject.
- Admin: team and RBAC matrix, action policy (which classes need confirmation),
  redaction policy, audit log.

Requirements:
- Every list is virtualised and paginated — these tables reach thousands of rows.
- Every mutation is optimistic with rollback on failure.
- Loading states are skeletons matching final layout, never spinners on full pages.
- Full keyboard navigation; WCAG AA contrast; prefers-reduced-motion respected.
- No client-side data fetching for anything that can be server-rendered.

Show me the plan and the route structure before writing components.
```

**Done when:**
```bash
pnpm --filter console build && pnpm --filter console test:e2e && pnpm --filter console test:a11y
```

---

## Phase 19 — Production hardening

**Depends on:** all
**Touches:** `infra/**`, all services

```text
Read docs/ARCHITECTURE.md § 7, § 8, § 9.

Close every gap between "works locally" and "runs in production".

Deliver:
- Helm chart per service: resource requests/limits, HPA on real signals, PDBs, liveness
  and readiness probes wired to the existing endpoints, graceful shutdown honoured.
- Terraform for managed Postgres, Redis, Qdrant, object storage, secrets.
- CI: lint, typecheck, unit, integration, e2e, and the three benchmark gates
  (speech-to-reticle, T0 resolution, scope recompute). A benchmark regression fails the build.
- Grafana dashboards as code for the metrics in ARCHITECTURE § 7, plus alerts:
  wispr_false_execution_total > 0 pages immediately; p95 speech-to-reticle > 400ms warns;
  memory staleness > 48h warns.
- A load test that drives 50 concurrent sessions and asserts the latency budgets hold.
- A security pass: dependency audit, CSP for the console, extension permission review
  against the manifest justifications, RLS verification test, an assertion that no raw
  element text appears in any log sink, and a check that no customer data reaches a model
  provider unredacted.
- Runbooks in docs/runbooks/ for: drift backlog, indexer failure, ASR provider outage,
  seed materializer failing across a tenant.

Report anything you could not complete rather than marking it done.
```

**Done when:**
```bash
make ci && make load-test && make security-audit
```

---

## Recovery prompts

Keep these to hand. Use them the moment something goes wrong rather than negotiating.

**It produced a stub**
```text
You produced placeholder code. CLAUDE.md § "Non-negotiable engineering rules" #1
forbids this. List every stub, mock return and TODO you wrote, then replace each with a
real implementation. If any of them cannot be implemented for real right now, tell me
which and why instead of stubbing it.
```

**It went outside scope**
```text
You modified files outside this phase's scope. Revert everything except <paths>. If you
believe a change elsewhere is necessary, explain why and wait — do not make it.
```

**It broke the contract**
```text
Your change does not match packages/protocol. The protocol package is the single source
of truth per CLAUDE.md rule #3. Re-read the relevant schemas and make the implementation
conform. Do not change the schema to fit the implementation without telling me first.
```

**It duplicated fingerprint logic**
```text
You wrote element resolution logic outside packages/fingerprint. CLAUDE.md rule #4
requires exactly one implementation shared by the extension and the indexer. Remove the
duplicate and import from the package.
```

**It hardcoded per-app knowledge**
```text
You hardcoded application-specific behaviour. Per CLAUDE.md § "generic vs
per-application", that value belongs in the memory record loaded at runtime. Show me
every place you did this and move each one into the appropriate table.
```

**It is going in circles**
```text
Stop. Do not write more code. Summarise: what you were trying to do, what you have tried,
what the actual error is, and the two or three options you see. Recommend one and wait.
```

**Session got too long**
```text
Summarise the current state in a form I can paste into a fresh session: what is done,
what is in progress, what is left in this phase, and any decisions made that are not yet
written into a file. Then tell me which of those decisions should be added to CLAUDE.md.
```
