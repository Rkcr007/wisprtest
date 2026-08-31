# WisprTest — current status

**Read this at the start of every session**, after `CLAUDE.md`. It is the map of what is
true in `main` today: what shipped, what is still open, and what to work next.

Last updated: **2026-08-31** (the false-execution report, end to end: contract, gateway,
console — and the console OIDC audience scope that had been keeping *every* console call to
the gateway from being accepted). If a fact here disagrees with the code, the code wins — fix
this file in the same PR.

The phase prompts in [`BUILD-PLAN.md`](BUILD-PLAN.md) still define *what* a phase must
deliver. This file records *whether* that delivery happened, and what was deliberately
left out.

---

## How to start a session

1. Read `CLAUDE.md` (rules, taxonomy, budgets).
2. Read **this file**.
3. Read `docs/ARCHITECTURE.md` for the module you will touch.
4. Honour `packages/protocol` — do not edit it from a feature track.
5. Pick **one** item from [Next work](#next-work). One owner, one directory, one branch,
   one PR ([ADR 0012](adr/0012-parallel-tracks.md)).
6. For anything over ~200 lines, plan first and wait for approval.

---

## Product, in one paragraph

WisprTest is a voice-native execution layer for manual QA. A tester names an app; the
indexer fingerprints it once; the tester narrates; the MV3 extension resolves and
dispatches against the live DOM in-process (no network on the hot path). Indexing,
memory sync, composition, and telemetry are the only cloud work. This is not a chatbot,
recorder, autonomous agent, or RPA tool.

---

## What is shipped (Phases 0–19)

| Area | State |
|------|--------|
| **0–2** Scaffold, protocol, fingerprint | Done |
| **3–5** Postgres + RLS, gateway, indexer | Done |
| **6–10** Extension HUD, runtime state, T0/T1, voice, speculation + CDP | Done |
| **11–13** T2 alias write-back, sessions, schema observation | Done |
| **14–16** Composer, seed plan/approve/revert, materializer chain | Done |
| **17** Drift detect → reconcile → human approve; drifted screens are Class A | Done |
| **18** Console | **Done** — Connect, Indexing, Overview, Memory, Data, Sessions (+ detail), Drift, Admin. Nonce CSP + security headers. |
| **19** Production hardening | **Mostly done** — see gaps below |

### Phase 19 that landed

- GitHub Actions merge gate (`.github/workflows/ci.yml`). The required check is the `ci`
  aggregate job. The three extension benchmarks run **report-only** on shared runners
  ([ADR 0014](adr/0014-benchmarks-report-only-in-ci.md)); `make bench` is the blocking
  performance gate on known hardware.
- Helm umbrella + Dockerfiles + `make kind-up` / `make kind-down` (Compose stays the
  data plane: Postgres, Redis, Qdrant, MinIO, Dex).
- Grafana dashboard JSON for series that exist (`infra/grafana/`). **No collector,
  Prometheus, or Grafana process** in Compose or kind.
- Console nonce CSP and hardening headers.
- Gateway operational gauges: `wispr_drift_open_total`, `wispr_memory_staleness_hours`
  (Postgres-backed, restart-safe).
- Indexer and gateway log redaction (PII keys).
- `make security-audit` → `infra/security/audit.mjs` (advisories, CSP, extension
  permissions, log redaction, RLS, model-boundary redaction).
- `make load-test` → `infra/load/run.mjs` (50 concurrent sessions; p95 must stay under
  800 ms; non-2xx fails the gate). Verified locally 2026-08-30: 50/50 sessions, max p95
  ~121 ms, gateway shutdown with `failed_hooks: []`.
- Gateway local telemetry: when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, NodeSDK default
  OTLP exporters are **explicitly disabled** so shutdown does not hang on a missing
  collector ([PR #37](https://github.com/Rkcr007/wisprtest/pull/37)).
- Runbooks under `docs/runbooks/`.

### Phase 19 that did **not** land (honest leftovers)

| Item | Why it is still open |
|------|----------------------|
| Terraform / managed cloud data plane | Explicitly out of scope for kind-first deploy. `BUILD-PLAN.md` still names it. |
| In-stack OTel collector + Prometheus + Grafana | Instruments export only if `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Dashboards import into a Grafana you already have. |
| Alert rule files | No PrometheusRule / Grafana alerts shipped. Gauges exist; nothing pages yet. |
| `wispr_speech_to_reticle_ms` at runtime | Build-time bench only. Runtime series is `wispr_speech_to_partial_ms` (excludes resolve). |
| `wispr_false_execution_total` producer | **Done.** `POST /v1/sessions/:id/false-executions` increments it, with `wispr_false_execution_withdrawn_total` and a `wispr_session_steps_total{outcome}` denominator beside it. The console session timeline files and withdraws reports. |
| Blocking CI benchmarks | Accepted as report-only until a runner whose performance is known exists. |
| `make build` / `gen:python` / `db-codegen` in CI | Not in the workflow. Generated pydantic/Kysely drift can merge. |
| End-to-end `make kind-up` on every machine | Scripts exist; last production-grade pass did **not** treat kind as verified on this workstation (kind/Helm must be installed). |

---

## Console routes (Phase 18)

| Path | Screen |
|------|--------|
| `/` | Connect / recent applications |
| `/applications/[id]` | Overview |
| `/applications/[id]/indexing` | Live index progress (SSE) |
| `/applications/[id]/memory` | Product Memory explorer |
| `/applications/[id]/data` | Schemas, materializers, ledger |
| `/applications/[id]/sessions` | Session list |
| `/applications/[id]/sessions/[sessionId]` | Timeline + evidence |
| `/applications/[id]/drift` | Pending reports, approve/reject |
| `/admin` | Team, policy, audit |

Health: `GET /api/healthz`, `GET /api/readyz`.

The session detail screen also carries the *False execution* column — the human end of the
release gate. Its BFF routes are `GET`/`POST /api/sessions/:id/false-executions` and
`POST /api/sessions/:id/false-executions/:ordinal/withdraw`.

**The console's access token only became acceptable to the gateway on 2026-08-31.** It
requested `scope=openid email profile` and sent the Auth0-style `audience` parameter, which Dex
ignores, so Dex minted `aud: wispr-console` and the gateway — which verifies
`aud: wispr-gateway` — refused every call. Nothing caught it because each side was tested
against its own mock of the other. The console now also asks for Dex's cross-client scope,
`audience:server:client_id:<audience>`, and the token comes back with
`aud: ["wispr-gateway", "wispr-console"]`. Measured against the running stack: the same call is
401 without the scope and 200 with it.

---

## Next work

Ordered by **priority**. Do not start two of these in the same directory in the same
cycle. **Do not edit `packages/protocol` from any of these** — item 1's contract has
already landed, so every track below rebases onto it and consumes it as it stands. A
further contract change is serialized through the lead and lands alone
([ADR 0012](adr/0012-parallel-tracks.md)).

### P0 — still blocks calling the product “measured production grade”

1. **False execution as a first-class outcome.** **Done.** `packages/protocol` defines
   `FalseExecutionReport` and its request shapes — a record adjacent to the step, not a sixth
   `ActionOutcome`, because a step's outcome is what happened at dispatch, falseness is judged
   afterwards, and `session_steps` is append-only so the timeline stays evidence. The gateway
   stores and counts one (`false_execution_reports`, three routes, three series). The console
   session timeline carries a *False execution* column through which a tester files and
   withdraws a report.

   Verified end to end on 2026-08-31 against the real stack: sign-in → session → step → file
   (201) → duplicate file (200, same report) → withdraw (200) → unexplained withdraw (400),
   with `wispr_false_execution_total`, `wispr_false_execution_withdrawn_total` and
   `wispr_session_steps_total` all observed leaving the process over OTLP.

   The gate is now **measured**, not merely measurable:

   ```
   (false_execution_total − false_execution_withdrawn_total) / session_steps_total{outcome="executed"}
   ```

   Remaining, and smaller: the extension's in-session path, so a tester can say it while
   testing rather than while reviewing. See [ADR 0005](adr/0005-reversibility-taxonomy.md).

2. **Observability stack.** A collector in Compose (and documented for kind) so
   gateway/indexer/composer actually export. Then dashboard panels for
   `wispr_drift_open_total` and `wispr_memory_staleness_hours`, plus alert rules:
   open drift / staleness > 48h warn; false-execution > 0 page *after* (1) exists.
3. **Release checklist.** A written path that runs `make bench` on known hardware,
   `make load-test`, `make security-audit`, and records the results. `make ci` locally
   is lint + typecheck only; GitHub Actions is the merge gate.

### P1 — correctness and ops debt already recorded in ADRs

4. **Verify `make kind-up` end-to-end** on a machine with Docker, kind, and Helm 3.
   Report real output; do not mark deploy done from scripts existing.
5. **Put `pnpm --filter protocol gen:python` and `make db-codegen` in CI** so the
   generated contract cannot silently drift ([ADR 0013](adr/0013-ci-is-the-merge-gate.md)).
6. **Screen-scoped aliases in Postgres.** Resolver implements them; unique key
   `(tenant_id, memory_version_id, phrase)` cannot ([ADR 0004](adr/0004-tiered-resolution-and-alias-writeback.md)).
7. **Store crawl bounds per application** so a failed materializer can re-queue
   observation ([ADR 0016](adr/0016-writes-go-through-the-indexer.md)).
8. **Qdrant `/readyz`.** Gateway readiness fails if Qdrant is down, and **nothing
   reads or writes Qdrant** (T1 is on-device ONNX). Decide: use it, or stop gating
   on it.
9. **Evidence downloads are served without a disposition header.** `signedUrl()` in
   `apps/gateway/src/storage/s3-evidence-store.ts` signs a bare `GetObjectCommand`, so
   object storage serves evidence with whatever content type it was stored under, and
   the console links it with a plain anchor. Storing `text/html` is now unrepresentable
   in the contract (`EvidenceUploadRequest` pins the type to the kind), so this is
   defence-in-depth rather than a live hole — but `ResponseContentDisposition:
   attachment` on the signed GET would stop the next admitted type from reopening it.

### P2 — budgets and product polish

10. Benchmarks that `CLAUDE.md` names but no suite covers: action dispatch p95 < 30 ms,
    indexer throughput > 8 routes/min, composition preview p95 < 1.2 s.
11. Runtime `wispr_speech_to_reticle_ms` (or a documented decision that the bench is
    enough).
12. Implement the GCP pilot blueprint in [`GCP-DEPLOYMENT.md`](GCP-DEPLOYMENT.md):
    Terraform, GCP Helm overlay, ingress, secret projection, collector, and rollout.
    The plan exists; the infrastructure does not.
13. Chrome Web Store / enterprise force-install packaging.

---

## What not to do

- Do not speculate on Class **C**. Drift forces Class **A**; confidence cannot override
  a stale structural hash.
- Do not write `if (app === '…')`. Per-app knowledge lives in memory tables.
- Do not log element text, utterances, or payloads (redaction keys exist for a reason).
- Do not duplicate `packages/fingerprint`.
- Do not add a collector-dependent shutdown path for local/dev without an explicit
  exporter config (see gateway `startTelemetry`).
- Do not “fix” report-only bench failures by loosening CLAUDE.md budgets to fit GitHub
  runners.

---

## Commands this repo actually has

```bash
make help
make dev                 # Compose + all services in watch mode
make lint typecheck      # also: make ci (local fast subset)
make bench               # blocking latency gate — known hardware, quiet machine
make load-test           # 50 sessions; needs migrated+seeded Compose
make security-audit      # blocking security pass; needs Docker + seeded DB
make kind-up / kind-down # control plane on kind; data plane stays Compose
make db-up db-migrate db-seed db-reset
```

Merge CI: `.github/workflows/ci.yml`. Required check name: **`ci`**. The job
`performance gates (report-only)` may go red from runner weather; it does not block
merge. Prefer `gh run rerun --failed` over changing the budget.

`make ci` runs `eslint .` at Node's default heap, which on most machines is **not enough**
for typescript-eslint's type-aware rules over this repo: it aborts with exit 134 and a
mark-compact OOM rather than a lint finding. That is the tree, not your change —
unmodified `main` does it too. Run `NODE_OPTIONS=--max-old-space-size=8192 pnpm lint`
locally; the CI `lint` job sets the same thing. A rerun will not clear it, because the
failure is deterministic.

The two `analyze` (CodeQL) checks **pass** as of 2026-08-31. They had failed on every run
with *"Code scanning is not enabled for this repository"*, which was never a finding: the
repository was private on a free plan, where uploading results needs Advanced Security
(`Advanced security has not been purchased`) and rulesets need Pro (`Upgrade to GitHub Pro`) —
so both the upload and the `core` ruleset [ADR 0015](adr/0015-codeql-and-the-ruleset-split.md)
describes were unavailable. Making the repository public restored both; no workflow change was
needed. If it ever goes private again, expect those two checks to start failing for that
reason and nothing else.

---

## Known divergences (code vs older prose)

Authoritative extra list: [`docs/adr/README.md`](adr/README.md) § Known divergences.

Short version:

- CI does not regenerate protocol/Kysely artifacts.
- Benchmarks in CI do not block.
- Qdrant is in the health check but unused.
- API materializer cannot replay bearer-token apps.
- Failed materializer is demoted; no automatic re-crawl.

---

## Documentation map

| File | Role |
|------|------|
| `CLAUDE.md` | Non-negotiable rules. Do not silently deviate. |
| `docs/STATUS.md` | **This file** — done / remaining / priority. |
| `docs/demo.html` | Static, keyboard-navigable product presentation (not a live app). |
| `docs/GCP-DEPLOYMENT.md` | GCP pilot architecture, cost estimate, implementation and go-live plan. |
| `docs/ARCHITECTURE.md` | System map, data model, observability contract. |
| `docs/BUILD-PLAN.md` | Phase prompts (what to build). Status notes at Phase 18–19. |
| `docs/TEST-DATA-ENGINE.md` | Generic vs per-app; adapters. |
| `docs/adr/` | Why, and what it cost. |
| `docs/runbooks/` | Incidents and deploy. |
| `infra/security/README.md` | Security gate. |
| `infra/load/README.md` | Load gate. |
| `infra/grafana/README.md` | Which series exist vs dashboards. |
