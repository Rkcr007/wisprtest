# CLAUDE.md

This file is loaded into every Claude Code session. Read it fully before doing anything.
If a request in chat conflicts with this file, say so and ask — do not silently deviate.

---

## What we are building

**WisprTest** — a voice-native execution layer for manual QA of enterprise web applications.

A tester names the app they are working on. WisprTest indexes it once, then the tester
narrates what they are doing — "open orders", "show me only the pending ones",
"I need a pending order for Acme with three line items", "approve it" — and WisprTest
executes it against the live DOM in under a second, generating any test data the flow
needs along the way.

**Core thesis:** `Think → Execute` becomes `Remember → Execute`. Expensive reasoning
happens once during indexing. Runtime is a lookup-and-dispatch problem measured in
milliseconds, not a reasoning problem measured in seconds.

**This is not** a chatbot, a test recorder, an autonomous agent, or an RPA tool.

---

## Non-negotiable engineering rules

1. **No placeholders.** No `TODO`, no `// implement later`, no mock returns, no fake
   abstractions. If a phase cannot be completed for real, stop and say why. A stub that
   returns hardcoded data is worse than an honest refusal.
2. **The hot path never crosses the network.** Speech → resolve → dispatch runs entirely
   in the extension. Cloud is for indexing, memory sync, composition, and telemetry only.
3. **Contracts before code.** Everything crossing a process boundary is defined in
   `packages/protocol` as a Zod schema first. Types are derived from schemas, never
   hand-written twice.
4. **Fingerprint logic has exactly one implementation.** `packages/fingerprint` is shared
   verbatim by the extension and the indexer. If they drift, resolution breaks. Never
   duplicate it.
5. **Every mutation of the app under test is reversible or gated.** See the reversibility
   taxonomy below. No exceptions.
6. **Every service ships with structured logging, metrics, tracing, and a health check.**
   Not added later. Part of the phase's definition of done.
7. **Multi-tenant from line one.** Every table has `tenant_id`. Every query is scoped.
   Every cache key is namespaced. There is no single-tenant mode to migrate off later.
8. **Typed end to end.** TypeScript `strict`. Python with full type hints and `mypy --strict`.
   No `any`, no bare `dict`.
9. **Tests are part of the deliverable.** Unit tests for resolvers and composers,
   integration tests for adapters, Playwright e2e for the runtime loop.
10. **Never commit secrets.** Config from env, validated at boot with Zod/pydantic.
    Boot fails loudly on missing config rather than defaulting.

---

## Reversibility taxonomy — memorise this

Every action WisprTest can perform is classified. The class determines whether
speculative execution is allowed.

| Class | Meaning | Speculative execution | Confirmation |
|-------|---------|----------------------|--------------|
| **R** — Reversible | focus, hover, scroll, expand, read-only navigation | Yes, on partial ASR hypothesis | No |
| **C** — Committing | submit, delete, approve, any state mutation | **Never** | Yes — finalized transcript + explicit yes |
| **A** — Ambiguous | resolver confidence below threshold | Pre-stage only (focus + reticle) | Yes |
| **S** — Seeding | test data creation | **Never** | Yes — preview shown before write |

Speculating on a Class C action is the single worst bug this product can have.
A confident wrong click costs more trust than any latency win gains.

---

## Repository layout

```
wisprtest/
├── CLAUDE.md                  ← this file
├── docs/
│   ├── ARCHITECTURE.md        ← system map, boundaries, data model
│   ├── TEST-DATA-ENGINE.md    ← generic vs per-app split, adapters
│   └── BUILD-PLAN.md          ← phased prompts, in order
├── packages/
│   ├── protocol/              ← Zod schemas + derived TS types (the contract)
│   ├── fingerprint/           ← element fingerprinting + scoring resolver (SHARED)
│   └── ui/                    ← design tokens + HUD primitives
├── apps/
│   ├── extension/             ← MV3 Chrome extension: runtime, HUD, voice, executor
│   ├── console/               ← Next.js 15 web console
│   ├── gateway/               ← Fastify: API, auth, tenancy, memory CRUD
│   ├── indexer/               ← Node + Playwright: crawl, fingerprint, observe schemas
│   └── composer/              ← FastAPI: schema inference, constraint solve, compose
├── db/                        ← SQL migrations (Atlas), seed fixtures
└── infra/                     ← Docker, Helm charts, Terraform
```

**Do not create directories outside this layout without asking.**

---

## Stack decisions, and why

| Layer | Choice | Reason |
|-------|--------|--------|
| Runtime | Chrome MV3 extension, TypeScript | Hot path must be in-process with the DOM. No network hop. |
| Indexer | Node + Playwright | Shares `packages/fingerprint` with the extension. One implementation. |
| Gateway | Fastify + TypeScript | Type sharing with protocol package; low overhead. |
| Composer | FastAPI + Python | Constraint solving and distribution sampling are cleaner in Python. |
| Console | Next.js 15 App Router, Tailwind, shadcn/ui, Zustand, TanStack Query | Per house standard. |
| Primary store | PostgreSQL 16 | Memory graph, schemas, ledger, sessions, audit. |
| Vector | Qdrant | Tier-1 embedding search over scoped element candidates + alias corpus. |
| Cache | Redis | Hot memory snapshots per `(tenant, app, version)`. |
| Observability | OpenTelemetry → Prometheus / Grafana / Loki | Mandatory per service. |
| Local orchestration | Docker Compose | `make dev` brings up everything. |

Python only in `apps/composer`. Anything touching DOM semantics is TypeScript so it can
share the fingerprint package.

---

## Resolution tiers — the performance contract

| Tier | Mechanism | Budget | Target share of commands |
|------|-----------|--------|--------------------------|
| **T0** | Exact/alias hit in the in-memory index | < 15 ms | > 80% |
| **T1** | Local embedding kNN over the scoped candidate set | < 40 ms | ~15% |
| **T2** | Small fast LLM, scoped candidates in prompt | < 800 ms | < 5% |

**Every T2 result writes back an alias**, so the same phrasing is T0 next time. That
write-back loop is the product's compounding asset. If you implement T2 without the
write-back, you have implemented a slower competitor.

Scoping is what makes T0/T1 fast *and* accurate: the runtime state engine narrows
candidates from thousands of DOM nodes to the dozens currently visible and reachable.
Never resolve against the full document.

---

## Performance budgets (these are tests, not aspirations)

| Metric | Budget |
|--------|--------|
| Speech onset → reticle rendered (p95) | < 400 ms |
| T0 resolution (p99) | < 15 ms |
| Action dispatch after commit (p95) | < 30 ms |
| Indexer throughput | > 8 routes/min |
| Composition preview generated (p95) | < 1.2 s |
| False execution rate | < 0.1% — release gate |

`false execution rate` gates every release. Latency regressions cost satisfaction;
false executions cost the account.

---

## What is generic vs what is per-application

This distinction governs the whole codebase. Get it wrong and you build a
consulting project instead of a product.

**Generic — written once, works for every customer app:**
crawler, fingerprinting, resolver, runtime state engine, voice pipeline, executor,
HUD, schema *inference* engine, constraint solver, composition engine, adapter
*interfaces*, ledger, drift detection.

**Per-application — learned or configured, NEVER hardcoded:**
element fingerprints, navigation graph, entity schemas, field value distributions,
referential graph, enum vocabularies, derived-field rules, materialization endpoints,
auth profiles, alias corpus.

If you find yourself writing `if (app === 'northstar')` anywhere, stop. That value
belongs in the per-application memory record, loaded at runtime.

See `docs/TEST-DATA-ENGINE.md` for the full treatment.

---

## Session protocol

At the start of every session:

1. Read `CLAUDE.md`, `docs/ARCHITECTURE.md`, and the current phase in `docs/BUILD-PLAN.md`.
2. Read `packages/protocol/src/**` — that is the contract you must honour.
3. State which phase you are on and what the definition of done is.
4. For any change over ~200 lines, produce a plan and wait for approval before writing code.
5. Work one phase at a time. Do not start the next phase in the same session.
6. Finish by running the phase's `Done when` command and reporting the real output.

Do not refactor files outside the current phase's scope. If you believe a change is
needed elsewhere, say so and ask.

---

## Conventions

- Package manager: `pnpm` workspaces. Python: `uv`.
- Commits: Conventional Commits. One commit per phase minimum.
- Errors: every service defines a typed error taxonomy; never throw bare `Error`.
- Logging: `pino` (Node) / `structlog` (Python). JSON. Always include
  `tenant_id`, `session_id`, `trace_id`. Never log element text content — it may contain PII.
- Naming: element ids are `screen.component.element` (e.g. `orders.filter.pending`).
- Time: UTC everywhere, ISO 8601 at boundaries.

---

## PII rule

Product Memory stores **structure**, never **content**. Accessible names are extracted,
scrubbed through the redaction pipeline, and only then persisted or placed in a prompt.
A table of customer names must never end up in memory or in an LLM request.
This is a procurement blocker, not a nice-to-have.
