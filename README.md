<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/logo-lockup-dark.svg" />
  <img src="docs/media/logo-lockup-light.svg" alt="WisprTest — Remember → Execute" width="360" />
</picture>

<h3>A voice-native execution layer for manual QA of enterprise web apps.</h3>

<p><em>Name your app. It indexes once. Then you just talk — and it executes against the live DOM in under a second.</em></p>

<img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=600&size=24&pause=1100&color=FFB454&center=true&vCenter=true&width=760&height=60&lines=%22open+orders%22;%22show+me+only+the+pending+ones%22;%22a+pending+order+for+Acme+with+three+line+items%22;%22approve+it%22" alt="Voice commands: open orders → show pending → seed data → approve" />

<br/>

<img alt="Phase" src="https://img.shields.io/badge/build_plan-10%20%2F%2019%20phases-FFB454?style=flat-square" />
<img alt="Hot path" src="https://img.shields.io/badge/hot_path-in--browser,_no_network-52E0AC?style=flat-square" />
<img alt="False execution" src="https://img.shields.io/badge/false_execution_rate-%3C%200.1%25%20(gated)-FF6B4A?style=flat-square" />
<img alt="License" src="https://img.shields.io/badge/license-proprietary-7FA8FF?style=flat-square" />

<br/>

<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white" />
<img alt="Python" src="https://img.shields.io/badge/Python-mypy--strict-3776AB?style=flat-square&logo=python&logoColor=white" />
<img alt="Chrome MV3" src="https://img.shields.io/badge/Chrome-MV3-4285F4?style=flat-square&logo=googlechrome&logoColor=white" />
<img alt="Playwright" src="https://img.shields.io/badge/Playwright-indexer-2EAD33?style=flat-square&logo=playwright&logoColor=white" />
<img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white" />
<img alt="Redis" src="https://img.shields.io/badge/Redis-7-DC382D?style=flat-square&logo=redis&logoColor=white" />

<br/><br/>

<a href="#-see-it-in-action"><b>See it in action</b></a> ·
<a href="#-the-thesis"><b>The thesis</b></a> ·
<a href="#-safety--speed"><b>Safety &amp; speed</b></a> ·
<a href="#-getting-started"><b>Getting started</b></a> ·
<a href="docs/ARCHITECTURE.md"><b>Architecture</b></a>

</div>

---

A tester narrates what they are doing —

> _"open orders"_ … _"show me only the pending ones"_ … _"I need a pending order for Acme
> with three line items"_ … _"approve it"_

— and WisprTest resolves each phrase against the live DOM and dispatches a **trusted**
event in milliseconds, generating any test data the flow needs along the way.

**This is not** a chatbot, a test recorder, an autonomous agent, or an RPA tool. It does
not _figure out_ your app at runtime — it **remembers** it.

---

## 🎬 See it in action

> **Demo screencast slot** — drop a real capture here once recorded.
> Suggested: `docs/media/demo.gif` (a 10–15s loop of the four commands above driving a
> real app), embedded as `<img src="docs/media/demo.gif" />`.
>
> <!-- ![WisprTest demo](docs/media/demo.gif) -->

Until then, here is the exact runtime path a single sentence travels — **on-page, no
network hop:**

```mermaid
sequenceDiagram
    actor Tester
    participant Voice as 🎙️ Voice<br/>(offscreen ASR)
    participant Resolve as 🔎 Resolver<br/>(scoped)
    participant Spec as ⚖️ Speculation<br/>(R/C/A/S)
    participant Exec as ⚡ Executor<br/>(CDP)

    Tester->>Voice: "show me only the pending ones"
    Voice-->>Resolve: partial hypothesis
    Resolve-->>Spec: resolved · T0 · 12 ms
    Note over Spec: class R — reversible
    Spec->>Exec: speculate (focus + reticle), keep rollback
    Tester->>Voice: …finishes the sentence
    Voice-->>Spec: final transcript
    Spec->>Exec: commit → trusted dispatch
    Exec-->>Tester: filtered to pending ✅
    Note over Spec,Exec: a committing verb ("approve it")<br/>would instead wait for final + 150ms stable + explicit yes
```

---

## 💡 The thesis

<div align="center">
<h3><code>Think → Execute</code> &nbsp;becomes&nbsp; <code>Remember → Execute</code></h3>
</div>

Expensive reasoning happens **once**, during indexing. Runtime is a lookup-and-dispatch
problem measured in **milliseconds**, not a reasoning problem measured in seconds.

```mermaid
flowchart LR
    subgraph Once["🧠 INDEX ONCE · cloud · seconds"]
        direction TB
        A[Playwright crawl] --> B[fingerprint every element]
        B --> C[observe entity schemas]
        C --> D[build navigation graph]
    end
    D ==> M[(📦 Product Memory)]
    M ==> Run
    subgraph Run["⚡ RUN CONTINUOUSLY · in-browser · milliseconds"]
        direction TB
        E[speech] --> F[scoped resolve] --> G[classify R/C/A/S] --> H[speculate / commit] --> I[trusted dispatch]
    end
    I -. novel phrasing resolved by LLM .-> WB[[write alias back]]
    WB -. so it is instant next time .-> M
```

The crawler does the hard thinking up front and writes it into **Product Memory**. When
the runtime _does_ have to reason — a phrasing it has never heard — it writes the answer
back as an alias, so the same words are an instant lookup next time. **That write-back
loop is the product's compounding asset.**

---

## 🛡️ Safety & speed

### 1 · The reversibility taxonomy — safety

Every action is classified, and the class decides whether the runtime may act on a
_partial_ speech hypothesis before you have finished the sentence.

```mermaid
flowchart TD
    P([partial hypothesis]) --> K{classify}
    K -->|R · reversible| SP["✅ execute speculatively<br/>focus · scroll · hover<br/>keep a rollback record"]
    K -->|C · committing| ST["🟠 reticle only<br/>submit · delete · approve"]
    K -->|A · ambiguous| ST
    K -->|S · seeding| PV["🟣 preview, await approval<br/>test-data creation"]
    ST --> G{final transcript<br/>+ 150 ms stable<br/>+ explicit yes?}
    G -->|yes| GO([⚡ dispatch])
    G -->|no| NO([🚫 never executes])
    SP -.on divergence.-> RB([↩ roll back])
```

|       Class        | Meaning                                      |     Speculative?      | Confirmation                   |
| :----------------: | -------------------------------------------- | :-------------------: | ------------------------------ |
| **R** — Reversible | focus, hover, scroll, expand, read-only nav  | **Yes**, on a partial | No                             |
| **C** — Committing | submit, delete, approve — any state mutation |       **Never**       | Yes — final + explicit _yes_   |
| **A** — Ambiguous  | resolver confidence below threshold          |    Pre-stage only     | Yes                            |
|  **S** — Seeding   | test-data creation                           |       **Never**       | Yes — preview before any write |

> ⚠️ Speculating on a Class **C** action is the single worst bug this product can have. A
> confident wrong click costs more trust than any latency win gains. A release-gate test
> proves a Class C action is **never** executed from a partial — even when the partial and
> final transcripts are byte-for-byte identical.

### 2 · Scoped, tiered resolution — speed

The runtime state engine narrows candidates from thousands of DOM nodes to the **dozens
currently visible and reachable**, then resolves in tiers — escalating only when it must.

```mermaid
flowchart TD
    U([utterance]) --> S[scope = visible ∩ reachable<br/>dozens, not thousands]
    S --> T0{T0 · exact / alias<br/>&lt; 15 ms}
    T0 -->|hit · over 80%| GO([⚡ dispatch])
    T0 -->|miss| T1{T1 · embedding kNN<br/>bge-small ONNX · &lt; 40 ms}
    T1 -->|hit · about 15%| GO
    T1 -->|miss| T2[T2 · small fast LLM<br/>scoped candidates &middot; &lt; 800 ms]
    T2 --> WB[[write alias back → T0 next time]]
    WB --> GO
```

### Performance budgets — enforced as tests, not aspirations

| Metric                                            |          Budget           |
| ------------------------------------------------- | :-----------------------: |
| Speech onset → reticle rendered (p95)             |       **< 400 ms**        |
| T0 resolution (p99)                               |        **< 15 ms**        |
| Action dispatch after commit (p95)                |        **< 30 ms**        |
| Scope recompute after mutation burst (3000 nodes) |        **< 8 ms**         |
| Indexer throughput                                |    **> 8 routes/min**     |
| **False execution rate**                          | **< 0.1% — release gate** |

Latency regressions cost satisfaction; false executions cost the account. Benchmarks fail
the build on regression.

---

## 🏗️ Architecture at a glance

```mermaid
flowchart TB
    subgraph B["🖥️ Tester's browser — the hot path · never crosses the network"]
        direction LR
        VOX[🎙️ Voice<br/>offscreen ASR] --> RES
        RT[Runtime<br/>state engine] --> RES[Resolver<br/>T0 / T1 / T2]
        RES --> SPEC[Speculation<br/>R / C / A / S] --> EXE[Executor<br/>CDP · trusted]
        HUD[HUD · React<br/>shadow DOM]
    end
    subgraph C["☁️ Control plane — index, sync, compose, telemetry"]
        direction LR
        GW[Gateway<br/>Fastify]
        IDX[Indexer<br/>Playwright]
        CMP[Composer<br/>FastAPI]
        CON[Console<br/>Next.js]
    end
    DB[(PostgreSQL 16<br/>memory · ledger · audit)]
    RD[(Redis<br/>hot snapshots)]
    QD[(Qdrant<br/>element vectors)]

    RES -. snapshot / alias write-back .-> GW
    EXE -. session steps .-> GW
    GW --> DB
    GW --> RD
    GW --> QD
    IDX --> DB
    IDX -. shares packages/fingerprint verbatim .- RES
```

Full system map, data model, and per-service responsibilities:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## 📂 Repository layout

```
wisprtest/
├── CLAUDE.md                  ← engineering rules & product contract (read first)
├── docs/
│   ├── ARCHITECTURE.md        ← system map, boundaries, data model
│   ├── TEST-DATA-ENGINE.md    ← generic vs per-app split, adapters
│   ├── BUILD-PLAN.md          ← phased prompts, in order
│   ├── adr/                   ← decision log: what was decided, and what it cost
│   └── runbooks/              ← drift backlog, indexer failure, ASR outage, seed failure
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
└── infra/                     ← Docker, Helm, Terraform (Phase 19 — not yet populated)
```

### Stack

| Layer         | Choice                                                           | Why                                                                           |
| ------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Runtime       | Chrome MV3 extension, TypeScript                                 | Hot path must be in-process with the DOM — no network hop                     |
| Indexer       | Node + Playwright                                                | Shares `packages/fingerprint` with the extension — one implementation         |
| Gateway       | Fastify + TypeScript                                             | Type sharing with the protocol package; low overhead                          |
| Composer      | FastAPI + Python                                                 | Constraint solving and distribution sampling are cleaner in Python            |
| Console       | Next.js App Router, Tailwind, shadcn/ui, Zustand, TanStack Query | House standard                                                                |
| Primary store | PostgreSQL 16                                                    | Memory graph, schemas, ledger, sessions, audit — every row `tenant_id`-scoped |
| Vector        | Qdrant                                                           | Embedding search over scoped candidates + alias corpus                        |
| Cache         | Redis                                                            | Hot memory snapshots per `(tenant, app, version)`                             |
| Object store  | MinIO (S3-compatible)                                            | Session evidence — screenshots and DOM snapshots, retrieved by signed URL     |
| Observability | OpenTelemetry → Prometheus / Grafana / Loki                      | Mandatory per service                                                         |
| Orchestration | Docker Compose                                                   | `make dev` brings up everything                                               |

---

## 🚀 Getting started

### Prerequisites

- **Node ≥ 22** and **pnpm** (`corepack enable` picks up the pinned version)
- **Python** with [**uv**](https://docs.astral.sh/uv/) (for `apps/composer`)
- **Docker** + Docker Compose (Postgres 16, Redis 7, Qdrant, MinIO)
- [**Atlas**](https://atlasgo.io/) for database migrations
- Google **Chrome** (the extension loads unpacked; e2e uses system Chromium)

### First run

```bash
pnpm install                # 1. install workspace dependencies
cp .env.example .env        # 2. create your local env file, then fill it in
make db-up                  # 3. bring up Postgres / Redis / Qdrant / MinIO (waits for healthy)
make db-reset               # 4. create the schema + load the test fixture
make dev                    # 5. run every service in watch mode
```

### Load the extension

1. `pnpm --filter extension build`
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked**
3. Select `apps/extension/dist`

<details>
<summary><b>Handy Make targets</b></summary>

```bash
make help          # list all targets
make dev           # infra + all services in watch mode
make build         # regenerate contract/schema types, then build every package
make test          # every workspace test suite
make lint          # ESLint + Prettier + ruff
make typecheck     # tsc --noEmit across TS, mypy --strict for composer
make db-up         # start Postgres / Redis / Qdrant / MinIO
make db-migrate    # apply Atlas migrations
make db-reset      # drop, recreate, migrate, seed (destructive; Compose DB only)
```

</details>

---

## 🧪 Testing

Tests are part of the deliverable — unit tests for resolvers and composers, integration
tests for adapters, and Playwright e2e for the runtime loop.

```bash
pnpm test                                        # everything
pnpm --filter fingerprint test -- --coverage     # scoring + resolve (≥90%)
pnpm --filter indexer test:e2e                   # crawl the fixture app, assert memory
pnpm --filter extension test:resolver            # T0/T1 resolution
pnpm --filter extension test:voice               # voice pipeline (scripted ASR fixture)
pnpm --filter extension test:speculation         # reversibility taxonomy + executor
pnpm --filter extension test:e2e:command         # real trusted CDP dispatch in Chromium
pnpm --filter extension bench:speech-to-reticle  # p95 < 400 ms gate
pnpm --filter extension bench:scope              # scope recompute < 8 ms gate
pnpm --filter console test                       # console: crawl bounds, SSE, auth, routes
```

The composer is Python and runs under `uv`, with its 90% coverage gate wired into pytest:

```bash
cd apps/composer && uv run mypy --strict src && uv run pytest -q
```

---

## 📈 Build progress

Built in the phased order defined in [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md).
**Phases 0–14 shipped; 18 and 19 partially landed.**

```mermaid
timeline
    title WisprTest build plan
    section ✅ Shipped
        Foundations : Scaffold : Protocol : Fingerprint
        Backend : DB + RLS : Gateway : Indexer
        Extension : HUD + design system : Runtime state engine : T0/T1 resolution : Voice pipeline : Speculation + CDP
        Learning : T2 write-back : Sessions
        Data engine : Schema observation : Composer
    section 🚧 Partly landed
        Product : Console — 2 of 8 screens : Hardening — CI + runbooks
    section 🔜 Planned
        Data engine : Seed preview + ledger : Materializer chain
        Learning : Drift detection + relearn
        Product : Remaining console screens : Helm / Terraform / load test
```

|   #   | Phase                                                  |         Status          |
| :---: | ------------------------------------------------------ | :---------------------: |
|  0–2  | Scaffold · Protocol · Fingerprint                      |           ✅            |
|  3–5  | DB + RLS · Gateway · Indexer                           |           ✅            |
|  6–7  | Extension shell + HUD · Runtime state engine           |           ✅            |
| 8–10  | T0/T1 resolution · Voice · Speculation + CDP execution |           ✅            |
| 11–13 | T2 write-back · Sessions · Schema observation          |           ✅            |
|  14   | Composer — contract, sampler, solver, provenance DAG   |           ✅            |
| 15–17 | Seed preview + ledger · Materializers · Drift          |       ⬜ planned        |
|  18   | Console — Connect + Indexing screens                   |    🚧 2 of 8 screens    |
|  19   | Production hardening — CI + runbooks landed early      | 🚧 `infra/` still empty |

> **Phase 18** is a deliberate slice: Connect (crawl bounds + start) and Indexing (live SSE
> progress) are built and tested, so an application can be indexed without touching a
> terminal. The other six screens depend on Phases 15 and 17 and are not started.
>
> **Phase 19** landed out of order — the CI pipeline and all four operational runbooks are
> in, while the Helm charts, Terraform, Grafana dashboards and load test are not.

Since Phase 14 the unit of work is a **track**, not a phase — one owner, one module, one
branch, one PR, several running concurrently. See [ADR 0012](docs/adr/0012-parallel-tracks.md)
for why, and what it cost.

---

## 📐 Engineering rules (the short version)

Non-negotiable and enforced in review. Full list in [`CLAUDE.md`](CLAUDE.md).

1. **No placeholders.** No `TODO`, no mock returns — an honest refusal beats a stub.
2. **The hot path never crosses the network.**
3. **Contracts before code.** Zod schemas in `packages/protocol` first; types are _derived_.
4. **Fingerprint logic has exactly one implementation** — shared verbatim by extension and indexer.
5. **Every mutation of the app under test is reversible or gated** (the taxonomy above).
6. **Every service ships with logging, metrics, tracing, and a health check** — as a definition of done.
7. **Multi-tenant from line one.** Every table has `tenant_id`; every query is scoped.
8. **Typed end to end.** TS `strict`, Python `mypy --strict`. No `any`, no bare `dict`.
9. **Tests are part of the deliverable.**
10. **Never commit secrets.** Config from env, validated at boot.

<details>
<summary><b>Generic vs per-application</b> — the distinction that governs the whole codebase</summary>

The crawler, fingerprinting, resolver, runtime engine, voice pipeline, executor, HUD,
schema inference, constraint solver, and adapter _interfaces_ are **generic** — written
once, work for every customer app. Element fingerprints, navigation graphs, entity
schemas, value distributions, enum vocabularies, and the alias corpus are
**per-application** — learned or configured, never hardcoded. If you ever write
`if (app === 'northstar')`, stop: that value belongs in the per-application memory record,
loaded at runtime.
</details>

### 🔒 PII rule

Product Memory stores **structure**, never **content**. Accessible names are extracted,
scrubbed through the redaction pipeline, and only then persisted or placed in a prompt. A
table of customer names must never reach memory or an LLM request. This is a procurement
blocker, not a nice-to-have.

---

## 📚 Documentation

| Document                                               | What's in it                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| [`CLAUDE.md`](CLAUDE.md)                               | Product contract, engineering rules, taxonomy, budgets            |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)         | System map, boundaries, extension internals, data model, security |
| [`docs/TEST-DATA-ENGINE.md`](docs/TEST-DATA-ENGINE.md) | Generic vs per-app data engine, adapters, composition             |
| [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md)             | The phased build plan, in order                                   |

---

<div align="center">
<sub>Proprietary — all rights reserved. · <code>Remember → Execute</code></sub>
</div>
