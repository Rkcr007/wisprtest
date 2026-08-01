# Operational runbooks

Four scenarios, named in `docs/BUILD-PLAN.md` Phase 19. Each runbook is: symptoms, how to
confirm, immediate mitigation, root-cause investigation, prevention.

| Runbook | Covers | Buildable today? |
|---------|--------|------------------|
| [drift-backlog.md](drift-backlog.md) | Memory going stale because drift reports are not being reviewed | **No** — Phase 17 is unbuilt |
| [indexer-failure.md](indexer-failure.md) | Crawl jobs failing, stalling, or leaving memory versions stuck `building` | **Yes** |
| [asr-provider-outage.md](asr-provider-outage.md) | Deepgram unreachable or degraded; testers cannot talk | **Partly** — no gateway-side ASR provisioning |
| [seed-materializer-failure.md](seed-materializer-failure.md) | Seeding failing across a tenant | **No** — Phases 15–16 are unbuilt |

---

## Read this before using any of them

**These runbooks describe the system at commit `81b786c`, which is mid-build.** Phases 0–13 are
complete, Phase 14 is roughly half done, and Phases 15–19 do not exist. Two of the four scenarios
above therefore cannot occur yet, because the subsystems that would produce them are unbuilt.

Each runbook states that at the top, in a *What exists today* section, and describes the
procedure against what will exist so it does not have to be written from scratch later.
Where a step depends on something unbuilt, it says so inline rather than describing tooling that
is not there. **A runbook step that names a command, table or endpoint has been checked against
the source.** Anything that could not be checked is marked.

`infra/` contains only `.gitkeep`. There are no Helm charts, no Terraform, and no Grafana
dashboards or alert rules — Phase 19 owns all of it. Every metric named below is emitted by the
service through OpenTelemetry (`OTEL_EXPORTER_OTLP_ENDPOINT`), and *nothing scrapes, stores or
alerts on it yet*. "Check the dashboard" means "query your metric backend once one is wired up."

The `make` targets that exist are: `dev`, `build`, `test`, `lint`, `typecheck`, `db-up`,
`db-down`, `db-logs`, `db-migrate`, `db-reset`, `db-seed`, `db-codegen`. `make ci`,
`make load-test` and `make security-audit` are named in Phase 19's `Done when` and do not exist.

---

## Alerts that cannot fire yet

`docs/ARCHITECTURE.md § 7` and Phase 19 name three alerts. Their current status:

| Alert | Metric | Status |
|-------|--------|--------|
| `wispr_false_execution_total > 0` pages immediately | `wispr_false_execution_total` | **Instrument exists, nothing increments it.** Registered in `apps/gateway/src/telemetry/metrics.ts` and covered by a unit test, but no production code path calls `.add()`, and `ActionOutcome` has no member meaning "wrong element". The release gate in `CLAUDE.md` is currently enforced by the Phase 10 speculation test, not by a measurement. See [ADR 0005](../adr/0005-reversibility-taxonomy.md). |
| p95 speech-to-reticle > 400 ms warns | `wispr_speech_to_reticle_ms` | **Metric does not exist.** It is named in `docs/ARCHITECTURE.md § 7` and nowhere in the code. What exists is a build-time benchmark, `apps/extension/test/bench/speech-to-reticle.bench.ts`, run by `pnpm --filter extension bench:speech-to-reticle`. The nearest runtime metric is `wispr_speech_to_partial_ms`, which measures speech onset to first ASR partial and excludes resolution. |
| memory staleness > 48 h warns | `wispr_memory_staleness_hours` | **Metric does not exist.** Named in § 7 only. `screens.indexed_at` and `memory_versions.created_at` hold the underlying data, so it is computable from Postgres today (see [drift-backlog.md](drift-backlog.md)). |
| — | `wispr_drift_open_total` | **Metric does not exist.** Named in § 7 only. Computable from `drift_reports` once anything writes to that table. |

Metrics that *are* emitted, and by which service:

| Service | Metrics |
|---------|---------|
| gateway (`apps/gateway/src/telemetry/metrics.ts`) | `wispr_seed_plan_latency_ms`, `wispr_seed_materialize_total`, `wispr_tier_total`, `wispr_resolution_latency_ms`, `wispr_false_execution_total`, `wispr_gateway_requests_total`, `wispr_gateway_request_duration_ms`, `wispr_memory_snapshot_total`, `wispr_memory_snapshot_build_ms` |
| indexer (`apps/indexer/src/telemetry/metrics.ts`) | `wispr_indexer_routes_total`, `wispr_indexer_route_duration_ms`, `wispr_indexer_elements_total`, `wispr_indexer_edges_total`, `wispr_indexer_entity_schemas_total`, `wispr_indexer_field_specs_total`, `wispr_indexer_materializers_total`, `wispr_indexer_jobs_total`, `wispr_indexer_job_duration_ms` |
| extension (`apps/extension/src/voice/messages.ts`) | `wispr_speech_to_partial_ms`, forwarded through the service worker |
| composer | **none** — OTel is a declared dependency in `pyproject.toml` but is not initialised |

Of the gateway's four `§ 7` instruments, only `wispr_tier_total` and `wispr_resolution_latency_ms`
have live call sites (`routes/sessions.ts`, `routes/resolve.ts`). The two `seed` instruments are
registered ahead of Phases 15–16 deliberately, so a dashboard can tell "zero" from "not deployed".

---

## Health and readiness

| Service | Liveness | Readiness | Notes |
|---------|----------|-----------|-------|
| gateway | `GET /healthz` | `GET /readyz` | Checks postgres, redis and qdrant individually; returns 503 with a per-dependency `checks` array. Both are public and exempt from rate limiting. |
| indexer | `GET /healthz` | `GET /readyz` | Plain `node:http` server on `INDEXER_HOST:INDEXER_PORT` (8081 locally). Both report `busy: true|false` — a draining node shows `busy:true` until its crawl finishes. `/readyz` checks postgres and redis. |
| composer | — | — | **No routes registered at all.** `apps/composer/src/composer/app.py` deliberately registers none; Phase 14 owns them. Nothing can probe it. |
| console | — | — | Scaffold only. |

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
