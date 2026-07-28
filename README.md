# WisprTest

**A voice-native execution layer for manual QA of enterprise web applications.**

A tester names the app they are working on. WisprTest indexes it once, then the tester
narrates what they are doing —

> *"open orders"* … *"show me only the pending ones"* … *"I need a pending order for Acme
> with three line items"* … *"approve it"*

— and WisprTest executes it against the live DOM in under a second, generating any test
data the flow needs along the way.

---

## The thesis

> **`Think → Execute` becomes `Remember → Execute`.**

Expensive reasoning happens **once**, during indexing. Runtime is a lookup-and-dispatch
problem measured in **milliseconds**, not a reasoning problem measured in seconds. The
crawler does the hard thinking up front and writes it into *Product Memory*; the runtime
just remembers and dispatches.

Every time the runtime does have to reason (a phrasing it has never heard), it writes the
answer back as an alias — so the same words are an instant lookup next time. **That
write-back loop is the product's compounding asset.**

### What it is not

Not a chatbot. Not a test recorder. Not an autonomous agent. Not an RPA tool. It does not
"figure out" your app at runtime — it *remembers* it, and dispatches trusted events into
the real DOM.

---

## How it works

```
        INDEX ONCE (cloud, seconds)              RUN CONTINUOUSLY (in-browser, milliseconds)

  ┌─────────────────────────────┐          ┌──────────────────────────────────────────────┐
  │  Playwright crawler          │          │  speech → partial hypothesis                 │
  │  → fingerprint every element │          │       → scoped resolve (T0 / T1 / T2)        │
  │  → observe entity schemas    │  ──────► │       → classify R / C / A / S               │
  │  → build the navigation graph│  Product │       → speculate or stage (reticle)         │
  │  → write Product Memory       │  Memory  │       → commit → dispatch trusted events     │
  └─────────────────────────────┘          │       → emit a session step                  │
                                            └──────────────────────────────────────────────┘
```

**The hot path never crosses the network.** Speech → resolve → dispatch runs entirely
inside the Chrome extension. The cloud is only for indexing, memory sync, data
composition, and telemetry.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full system map, data model,
and service responsibilities.

---

## Two ideas that make it safe and fast

### 1. The reversibility taxonomy — safety

Every action is classified, and the class decides whether the runtime may act on a
*partial* speech hypothesis before you have finished the sentence.

| Class | Meaning | Speculative execution | Confirmation |
|:-----:|---------|-----------------------|--------------|
| **R** — Reversible | focus, hover, scroll, expand, read-only nav | **Yes**, on a partial hypothesis | No |
| **C** — Committing | submit, delete, approve — any state mutation | **Never** | Yes — final transcript + explicit *yes* |
| **A** — Ambiguous | resolver confidence below threshold | Pre-stage only (reticle) | Yes |
| **S** — Seeding | test-data creation | **Never** | Yes — preview shown before any write |

> Speculating on a Class **C** action is the single worst bug this product can have. A
> confident wrong click costs more trust than any latency win gains. A Class C action
> requires a **finalized transcript + a 150 ms stability window + explicit confirmation** —
> and there is a release-gate test proving it is *never* executed from a partial, even when
> the partial and final transcripts are identical.

### 2. Scoped, tiered resolution — speed

The runtime state engine narrows candidates from thousands of DOM nodes to the **dozens
currently visible and reachable**, then resolves against that small set in tiers:

| Tier | Mechanism | Budget | Target share |
|:----:|-----------|:------:|:------------:|
| **T0** | Exact / alias hit in the in-memory index | < 15 ms | > 80% |
| **T1** | Local embedding kNN over scoped candidates (bge-small ONNX, WASM) | < 40 ms | ~15% |
| **T2** | Small fast LLM, scoped candidates in prompt | < 800 ms | < 5% |

Every T2 result writes an alias back, so the same phrasing is T0 next time.

---

## Performance budgets (enforced as tests, not aspirations)

| Metric | Budget |
|--------|:------:|
| Speech onset → reticle rendered (p95) | < 400 ms |
| T0 resolution (p99) | < 15 ms |
| Action dispatch after commit (p95) | < 30 ms |
| Scope recompute after mutation burst (3000 nodes) | < 8 ms |
| Indexer throughput | > 8 routes/min |
| **False execution rate** | **< 0.1% — release gate** |

Latency regressions cost satisfaction; false executions cost the account. Benchmarks fail
the build on regression.

---

## Repository layout

```
wisprtest/
├── CLAUDE.md                  ← engineering rules & product contract (read this first)
├── docs/
│   ├── ARCHITECTURE.md        ← system map, boundaries, data model
│   ├── TEST-DATA-ENGINE.md    ← generic vs per-app split, adapters
│   └── BUILD-PLAN.md          ← phased prompts, in order
├── packages/
│   ├── protocol/              ← Zod schemas + derived TS types (the contract)
│   ├── fingerprint/           ← element fingerprinting + scoring resolver (SHARED verbatim)
│   └── ui/                    ← design tokens + HUD primitives
├── apps/
│   ├── extension/             ← MV3 Chrome extension: runtime, HUD, voice, executor
│   ├── console/               ← Next.js web console
│   ├── gateway/               ← Fastify: API, auth, tenancy, memory CRUD
│   ├── indexer/               ← Node + Playwright: crawl, fingerprint, observe schemas
│   └── composer/              ← FastAPI: schema inference, constraint solve, compose
├── db/                        ← SQL migrations (Atlas), seed fixtures
└── infra/                     ← Docker, Helm, Terraform
```

### Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Chrome MV3 extension, TypeScript | Hot path must be in-process with the DOM — no network hop |
| Indexer | Node + Playwright | Shares `packages/fingerprint` with the extension — one implementation |
| Gateway | Fastify + TypeScript | Type sharing with the protocol package; low overhead |
| Composer | FastAPI + Python | Constraint solving and distribution sampling are cleaner in Python |
| Console | Next.js App Router, Tailwind, shadcn/ui, Zustand, TanStack Query | House standard |
| Primary store | PostgreSQL 16 | Memory graph, schemas, ledger, sessions, audit — every row `tenant_id`-scoped |
| Vector | Qdrant | Embedding search over scoped candidates + alias corpus |
| Cache | Redis | Hot memory snapshots per `(tenant, app, version)` |
| Observability | OpenTelemetry → Prometheus / Grafana / Loki | Mandatory per service |
| Orchestration | Docker Compose | `make dev` brings up everything |

---

## Getting started

### Prerequisites

- **Node ≥ 22** and **pnpm** (`corepack enable` picks up the pinned version)
- **Python** with [**uv**](https://docs.astral.sh/uv/) (for `apps/composer`)
- **Docker** + Docker Compose (Postgres 16, Redis 7, Qdrant)
- [**Atlas**](https://atlasgo.io/) for database migrations
- Google **Chrome** (the extension loads unpacked; e2e uses system Chromium)

### First run

```bash
# 1. Install workspace dependencies
pnpm install

# 2. Create your local env file (auto-copied from .env.example on first make target)
cp .env.example .env        # then fill in the values

# 3. Bring up infrastructure (blocks until Postgres/Redis/Qdrant are healthy)
make db-up

# 4. Create the schema and load the test fixture
make db-reset               # drop + recreate + migrate + seed (Compose DB only)

# 5. Run everything in watch mode
make dev
```

`make dev` exports `.env`, starts the infrastructure, and runs every service — including
the extension in watch mode for unpacked loading.

### Load the extension

1. `pnpm --filter extension build`
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked**
3. Select `apps/extension/dist`

### Handy Make targets

```bash
make help          # list all targets
make dev           # infra + all services in watch mode
make build         # regenerate contract/schema types, then build every package
make test          # every workspace test suite
make lint          # ESLint + Prettier + ruff
make typecheck     # tsc --noEmit across TS, mypy --strict for composer
make db-up         # start Postgres / Redis / Qdrant
make db-migrate    # apply Atlas migrations
make db-reset      # drop, recreate, migrate, seed (destructive; Compose DB only)
```

---

## Testing

Tests are part of the deliverable — unit tests for resolvers and composers, integration
tests for adapters, and Playwright e2e for the runtime loop.

```bash
pnpm test                                        # everything
pnpm --filter protocol test                      # schema round-trips
pnpm --filter fingerprint test -- --coverage     # scoring + resolve (≥90%)
pnpm --filter gateway test                        # gateway integration (against Compose)
pnpm --filter indexer test:e2e                   # crawl the fixture app, assert memory
pnpm --filter extension test                      # extension unit suite
pnpm --filter extension test:e2e                 # Playwright: HUD mounts & drags
pnpm --filter extension test:resolver            # T0/T1 resolution
pnpm --filter extension test:voice               # voice pipeline (scripted ASR fixture)
pnpm --filter extension test:speculation         # reversibility taxonomy + executor
pnpm --filter extension test:e2e:command         # real trusted CDP dispatch in Chromium
pnpm --filter extension bench:speech-to-reticle  # p95 < 400 ms gate
pnpm --filter extension bench:scope              # scope recompute < 8 ms gate
```

---

## Implementation status

Built in the phased order defined in [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md).

| # | Phase | Status |
|:-:|-------|:------:|
| 0 | Repository scaffold | ✅ |
| 1 | Protocol package — the contract | ✅ |
| 2 | Fingerprint package (shared resolution logic) | ✅ |
| 3 | Database schema + row-level security | ✅ |
| 4 | Gateway: auth, tenancy, observability, repositories | ✅ |
| 5 | Indexer: bounded Playwright crawl → memory version | ✅ |
| 6 | Extension shell + shadow-DOM HUD + design system | ✅ |
| 7 | Runtime state engine + incremental scoped index | ✅ |
| 8 | Memory snapshot + T0/T1 resolution | ✅ |
| 9 | Voice pipeline (offscreen ASR) | ✅ |
| 10 | Speculation, reticle, CDP execution | ✅ |
| 11 | T2 escalation + alias write-back loop | ⬜ planned |
| 12 | Sessions | ⬜ planned |
| 13 | Schema observation | ⬜ planned |
| 14 | Composer service | ⬜ scaffold only |
| 15 | Seed preview, UI materializer, ledger | ⬜ planned |
| 16 | API materializer + fallback chain | ⬜ planned |
| 17 | Drift detection + relearn | ⬜ planned |
| 18 | Console | ⬜ scaffold only |
| 19 | Production hardening | ⬜ planned |

---

## Engineering rules (the short version)

These are non-negotiable and enforced in review. The full list is in
[`CLAUDE.md`](CLAUDE.md).

1. **No placeholders.** No `TODO`, no mock returns, no fake abstractions. An honest
   refusal beats a stub that returns hardcoded data.
2. **The hot path never crosses the network.** Speech → resolve → dispatch stays in the
   extension.
3. **Contracts before code.** Everything crossing a process boundary is a Zod schema in
   `packages/protocol` first; types are *derived*, never hand-written twice.
4. **Fingerprint logic has exactly one implementation** — `packages/fingerprint`, shared
   verbatim by the extension and the indexer.
5. **Every mutation of the app under test is reversible or gated** (the taxonomy above).
6. **Every service ships with structured logging, metrics, tracing, and a health check** —
   part of a phase's definition of done, not added later.
7. **Multi-tenant from line one.** Every table has `tenant_id`; every query is scoped;
   every cache key is namespaced.
8. **Typed end to end.** TypeScript `strict`, Python `mypy --strict`. No `any`, no bare
   `dict`.
9. **Tests are part of the deliverable.**
10. **Never commit secrets.** Config from env, validated at boot; boot fails loudly on
    missing config.

### Generic vs per-application

This distinction governs the whole codebase. The crawler, fingerprinting, resolver,
runtime engine, voice pipeline, executor, HUD, schema inference, constraint solver, and
adapter *interfaces* are **generic** — written once, work for every customer app.
Element fingerprints, navigation graphs, entity schemas, value distributions, enum
vocabularies, and the alias corpus are **per-application** — learned or configured, never
hardcoded. If you ever write `if (app === 'northstar')`, stop: that value belongs in the
per-application memory record, loaded at runtime.

### PII rule

Product Memory stores **structure**, never **content**. Accessible names are extracted,
scrubbed through the redaction pipeline, and only then persisted or placed in a prompt. A
table of customer names must never reach memory or an LLM request. This is a procurement
blocker, not a nice-to-have.

---

## Documentation

| Document | What's in it |
|----------|--------------|
| [`CLAUDE.md`](CLAUDE.md) | Product contract, engineering rules, taxonomy, budgets |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System map, package boundaries, extension internals, data model, security |
| [`docs/TEST-DATA-ENGINE.md`](docs/TEST-DATA-ENGINE.md) | Generic vs per-app data engine, adapters, composition |
| [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md) | The phased build plan, in order |

---

## License

Proprietary — all rights reserved.
