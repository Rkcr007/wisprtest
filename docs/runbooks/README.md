# Operational runbooks

The four operational scenarios named in `docs/BUILD-PLAN.md` Phase 19, plus how to deploy the
control plane on kind. The incident runbooks are: symptoms, how to confirm, immediate mitigation,
root-cause investigation, prevention.

| Runbook | Covers | Buildable today? |
|---------|--------|------------------|
| [deploy.md](deploy.md) | kind-up / kind-down, how a tester uses console + extension | **Yes** — kind-first; cloud Terraform is out of scope |
| [drift-backlog.md](drift-backlog.md) | Memory going stale because drift reports are not being reviewed | **Yes** — console Drift screen + API |
| [indexer-failure.md](indexer-failure.md) | Crawl jobs failing, stalling, or leaving memory versions stuck `building` | **Yes** |
| [asr-provider-outage.md](asr-provider-outage.md) | Deepgram unreachable or degraded; testers cannot talk | **Partly** — no gateway-side ASR provisioning |
| [seed-materializer-failure.md](seed-materializer-failure.md) | Seeding failing across a tenant | **Yes** — all three adapters and the fallback chain are live |

---

## Read this before using any of them

**These runbooks describe the system as of 2026-08-30.** Phases 0–18 are complete; Phase 19
is mostly complete. Leftovers and priority: [`docs/STATUS.md`](../STATUS.md).

Each runbook opens with a *What exists today* section naming what is live and what is not. Where a
step depends on something unbuilt, it says so inline rather than describing tooling that is not
there. **A runbook step that names a command, table or endpoint has been checked against the
source.** Anything that could not be checked is marked.

The console now has Overview, Memory, Data, Sessions, Drift, and Admin in addition to Connect and
Indexing. Operators should use those screens first; API and SQL remain for when the UI is down.

`infra/helm/wisprtest/` is a kind-first Helm umbrella for the four app-plane services. The data
plane is still Compose. Grafana dashboard JSON lives in `infra/grafana/` for series that are
actually emitted; there is still no collector in the stack, so "check the dashboard" means
"import those files into a Grafana that has a Prometheus once one is wired up." There is no
Terraform. See [deploy.md](deploy.md).

The `make` targets that exist include: `dev`, `build`, `test`, `bench`, `lint`, `typecheck`,
`ci` (local lint+typecheck), `load-test`, `security-audit`, `db-up`, `db-down`, `db-logs`,
`db-migrate`, `db-reset`, `db-seed`, `db-codegen`, `kind-up`, `kind-down`.

**The CI pipeline** (`.github/workflows/ci.yml`) is a merge gate and not an operational one — it tells you a change is safe to land, not that a
deployment is healthy. Two things about it are worth knowing while holding a pager:

- The `bench` job is **report-only** and excluded from the required check. The latency budgets are
  enforced by `make bench` on known hardware, not by CI. See
  [ADR 0014](../adr/0014-benchmarks-report-only-in-ci.md).
- No CI job runs `make build`, so `pnpm --filter protocol gen:python` and `make db-codegen` never
  run there. A generated pydantic model or Kysely type that has drifted from its source will not be
  caught before merge. See [ADR 0013](../adr/0013-ci-is-the-merge-gate.md).

---

## Alerts that cannot fire yet

`docs/ARCHITECTURE.md § 7` and Phase 19 name three alerts. Gauges for drift-open and
memory-staleness now exist; they still cannot *page* without a collector and a rule file.
False-execution and speech-to-reticle remain incomplete. Current status:

| Alert | Metric | Status |
|-------|--------|--------|
| `wispr_false_execution_total > 0` pages immediately | `wispr_false_execution_total` | **Instrument exists, nothing increments it.** Registered in `apps/gateway/src/telemetry/metrics.ts` and covered by a unit test, but no production code path calls `.add()`, and `ActionOutcome` has no member meaning "wrong element". The release gate in `CLAUDE.md` is currently enforced by the Phase 10 speculation test, not by a measurement. See [ADR 0005](../adr/0005-reversibility-taxonomy.md). |
| p95 speech-to-reticle > 400 ms warns | `wispr_speech_to_reticle_ms` | **Runtime metric does not exist.** Build-time benchmark only (`apps/extension/test/bench/speech-to-reticle.bench.ts`). Nearest runtime series is `wispr_speech_to_partial_ms` (excludes resolution). |
| memory staleness > 48 h warns | `wispr_memory_staleness_hours` | **Gauge is emitted** from Postgres (`apps/gateway/src/telemetry/operational-metrics.ts`). No alert rule and no collector, so it will not page. SQL in [drift-backlog.md](drift-backlog.md) still works. |
| open drift queue | `wispr_drift_open_total` | **Gauge is emitted** (open reports per tenant/app). Raise counter `wispr_drift_reports_total` still exists. No alert rule file yet. |

Metrics that *are* emitted, and by which service:

| Service | Metrics |
|---------|---------|
| gateway (`apps/gateway/src/telemetry/metrics.ts`) | `wispr_gateway_requests_total`, `wispr_gateway_request_duration_ms`, `wispr_tier_total`, `wispr_resolution_latency_ms`, `wispr_false_execution_total`, `wispr_memory_snapshot_total`, `wispr_memory_snapshot_build_ms`, `wispr_seed_plan_latency_ms`, `wispr_seed_materialize_total`, `wispr_drift_reports_total`, `wispr_drift_decisions_total`, `wispr_drift_open_total`, `wispr_memory_staleness_hours`, `wispr_index_jobs_enqueued_total`, `wispr_index_progress_events_total`, `wispr_index_progress_subscribers` |
| indexer (`apps/indexer/src/telemetry/metrics.ts`) | `wispr_indexer_routes_total`, `wispr_indexer_route_duration_ms`, `wispr_indexer_elements_total`, `wispr_indexer_edges_total`, `wispr_indexer_entity_schemas_total`, `wispr_indexer_field_specs_total`, `wispr_indexer_materializers_total`, `wispr_indexer_jobs_total`, `wispr_indexer_job_duration_ms`, `wispr_indexer_drift_reconciles_total`, `wispr_indexer_drift_reconcile_duration_ms`, `wispr_indexer_drift_alias_migration_rate` |
| extension (`apps/extension/src/voice/messages.ts`) | `wispr_speech_to_partial_ms`, forwarded through the service worker |
| composer (`apps/composer/src/composer/telemetry.py`) | `wispr_seed_plan_latency_ms`, `wispr_tier_total`, `wispr_compose_outcome_total` |

`wispr_seed_plan_latency_ms` and `wispr_tier_total` are emitted by **both** the gateway and the
composer, deliberately: the gateway measures the round trip a tester waits on and the composer
measures its own share of it. Aggregating them without a `service` dimension will double-count.

`wispr_false_execution_total` is the one § 7 instrument still with no call site — see the alert
table above. Drift-open and memory-staleness gauges now exist; they still cannot fire an alert
without a collector and a rule.

---

## Health and readiness

| Service | Liveness | Readiness | Notes |
|---------|----------|-----------|-------|
| gateway | `GET /healthz` | `GET /readyz` | Checks postgres, redis and qdrant individually; returns 503 with a per-dependency `checks` array. Both are public and exempt from rate limiting. |
| indexer | `GET /healthz` | `GET /readyz` | Plain `node:http` server on `INDEXER_HOST:INDEXER_PORT` (8081 locally). Both report `busy: true|false` — a draining node shows `busy:true` until its crawl finishes. `/readyz` checks postgres and redis. |
| composer | `GET /healthz` | `GET /readyz` | Registered by `create_router` (`apps/composer/src/composer/routes.py`) alongside `POST /compose`. `/readyz` reports readiness only — the composer holds no database or cache connection of its own. |
| console | `GET /api/healthz` | `GET /api/readyz` | Liveness touches nothing external. Readiness asks the gateway `/readyz` (then `/healthz` if that path is missing) and never attaches a token. |

**A note on the gateway's Qdrant check.** `/readyz` fails if Qdrant is unreachable, and *nothing
in the codebase reads or writes Qdrant* — T1 embedding runs locally in the extension with a
bundled ONNX model, and there is no Qdrant client anywhere. A Qdrant outage will therefore pull
every gateway replica out of rotation for a dependency that carries no function today. Worth
knowing before it happens at 3 a.m.

---

## Log fields you can rely on

Every gateway line carries `service`, `env`, `time` (ISO 8601 UTC), `level`, and — inside a
request — `tenant_id`, `session_id`, `trace_id`, `request_id`, `user_id`, injected by a pino mixin
from `AsyncLocalStorage`. Outside a request those fields are absent rather than null, which is
itself information: the line did not happen while serving anybody.

Indexer job lines carry `tenant_id`, `job_id`, `application_id` from a child logger, and an
`event` field: `job.started`, `job.completed`, `job.cancelled`, `job.failed`,
`job.fail_write_failed`, `schemas.observed`, `progress.publish_failed`, `checkpoint.failed`.
Worker-loop lines use `worker.listening`, `worker.read_failed`, `worker.job_invalid`,
`worker.job_requeued`, `worker.stopped`.

**Some fields are censored and you cannot un-censor them at runtime.**
`apps/gateway/src/logger.ts` redacts by key: `accessibleName`, `accessibleNameRedacted`, `label`,
`targetPhrase`, `utterance`, `phrase`, `text`, `textContent`, `value`, `payload`, `password`,
`token`, `authorization`, plus `req.headers.authorization` and `req.headers.cookie`, with
wildcards to four levels of nesting. `value` and `payload` are exactly the fields you will want
during a seeding investigation and they will read `[redacted]`. That is [ADR 0009](../adr/0009-structure-not-content.md)
working as intended. Do not add a carve-out; add a more specific field name to the log call.
