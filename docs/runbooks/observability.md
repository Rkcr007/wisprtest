# Runbook — the observability stack

What to do when one of the rules in `infra/prometheus/rules/wispr.yml` fires, and how to look at
the system when nothing has fired and you want to know how it is doing.

Every service in this repository has been instrumented since Phase 12 and exported to nothing
until this stack existed. If a panel is empty, the first question is always whether the service
is exporting at all — see [No telemetry from a service](#no-telemetry-from-a-service).

---

## Bringing it up

```bash
make obs-up      # collector + Prometheus + Grafana, behind the `observability` compose profile
make obs-down    # stops those three; leaves postgres/redis/qdrant/minio/dex and all volumes
```

| What | Where |
|------|-------|
| Grafana (no login, `WisprTest` folder) | http://localhost:3001/dashboards |
| Prometheus alerts | http://localhost:9090/alerts |
| Prometheus rule health | http://localhost:9090/rules |
| Collector's own metrics | http://localhost:8888/metrics (inside the compose network) |

**Services export only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.** It is commented out in
`.env.example` because the profile is opt-in and the two have to agree: a service pointed at a
collector that is not running retries every export on a timer and fills the log with failures it
can do nothing about. `make obs-up` prints the line to add. After adding it, restart the services —
the SDK reads it once, at boot.

---

## The dashboards

Three, provisioned from `infra/grafana/dashboards/` and read-only in the UI (they are
dashboards-as-code; a panel edited in the browser vanishes on the next restart).

`wispr_seed_plan_latency_ms` and `wispr_tier_total` are emitted by **both** the gateway and the
composer. Every query filters on `service_name` for that reason. If a number looks like exactly
twice what you expect, that filter is missing.

---

## Alerts

### False execution rate breached

**Severity: page.** `CLAUDE.md` budgets the false execution rate at **< 0.1%** and calls it the
metric that gates every release. This is the only alert in the file that blocks a release.

The expression is three series, and the shape matters:

```
( increase(wispr_false_execution_total[6h]) - increase(wispr_false_execution_withdrawn_total[6h]) )
/ increase(wispr_session_steps_total{outcome="executed"}[6h])
```

A withdrawal has to come back out of the numerator, and only `executed` steps belong in the
denominator — a staged action that never ran cannot have been a false execution. The rule also
requires **at least 500 executed steps** in the window, because one report against three steps is
33% and means nothing.

**What to do.** Do not silence it. Open the console's session list, filter to the reports, and read
the `reason` on each — they are fixed in different places, and the split tells you where:

| Reason | What broke | Where it is fixed |
|--------|-----------|-------------------|
| `wrong_element` | Resolver named the wrong thing | The alias corpus. Check whether T2 write-back is landing. |
| `wrong_action` | Right target, wrong verb | The intent parser's verb lexicon. |
| `unintended_state_change` | We did what was asked and something else changed | The application's own bug, not ours. |

A cluster of `wrong_element` on one screen is usually drift: check
[drift-backlog.md](drift-backlog.md) before treating it as a resolver regression.

### False execution reported

**Severity: warn.** A human said we got it wrong. It deserves a ticket the same day and never
deserves a 3 a.m. page — the *rate* is the gate, and it is the rule above. Triage as in the table.

### Near-miss rate high

**Severity: warn.** A `rejected` step is a committing action a tester refused out loud — they said
"stop" while it was staged, and it never ran ([ADR 0018](../adr/0018-barge-in-halts-on-a-stable-partial.md)).

Nothing has gone wrong when this fires. Every one of these was caught, by design, by the class-C
confirmation gate. It matters because it is a **leading indicator**: the resolver is proposing the
wrong target often enough that testers keep having to refuse it, and the difference between a
near-miss and a false execution is whether the tester was paying attention. Treat a sustained climb
here as the false-execution gate breaching next week.

### Memory stale

**Severity: warn.** The newest screen in an application's active memory was indexed more than 48
hours ago. Stale memory is not merely old: a drifted screen forces every resolution on it to Class
A, so the tester is confirming actions they should not have to confirm, and the product feels like
a chatbot. Re-crawl. SQL for finding the affected applications is in
[drift-backlog.md](drift-backlog.md).

### Drift backlog stuck

**Severity: warn.** Drift reports have been awaiting a human approve/reject for 24 hours. Nothing
reconciles itself. Until they are decided the affected screens stay Class A. See
[drift-backlog.md](drift-backlog.md).

### Gateway error rate high

**Severity: page.** More than 5% of gateway requests are 5xx over 5 minutes. Check
`docker compose logs` for the gateway, then Postgres and Redis health — the gateway's `/readyz`
fails closed on both.

### Gateway latency high

**Severity: warn.** p95 over 800 ms, which is the budget `make load-test` enforces at 50 concurrent
sessions. This is **not** the voice hot path — speech to dispatch never crosses the network — but
indexing, snapshot sync and session writes all run through here. Check snapshot cache hit rate
first (`wispr_memory_snapshot_total` by `result`): a collapsed hit rate means every request is
rebuilding a snapshot from Postgres.

### No telemetry from a service

**Severity: page.** The services *push*; there is no `up` series for them, so absence of the
counter is the signal. **Every other alert in the file is blind while this is firing** — a
collector that is down looks exactly like a system with no problems.

Check in this order:

1. Is the service running at all?
2. Is `OTEL_EXPORTER_OTLP_ENDPOINT` set in its environment? This is the usual answer, and it is
   silent by design — a service with it unset logs its mode at boot and then behaves normally.
3. Is the collector healthy? `docker compose ps otel-collector`.
4. Is Prometheus scraping it? http://localhost:9090/targets

### Collector dropping data

**Severity: warn.** The collector is receiving telemetry and failing to forward it
(`otelcol_exporter_send_failed_metric_points`). Dashboards look **sparse rather than empty**, which
is the most misleading failure mode this stack has — it reads as "quiet system" instead of "broken
pipeline".

### Collector refusing data

**Severity: warn.** Backpressure: `memory_limiter` is shedding load at the receiver rather than the
exporter losing it. Raise the collector's memory limit or give the container more.

---

## What still cannot be alerted on

Honesty about coverage, because a gap you know about is manageable and a gap you assume is covered
is not.

| Budget in `CLAUDE.md` | Status |
|---|---|
| Speech onset → reticle p95 < 400 ms | **No runtime series exists.** `wispr_speech_to_reticle_ms` is a build-time benchmark (`apps/extension/test/bench/`). The extension runs in the tester's browser with no exporter, so there is nothing to alert on. The nearest runtime series, `wispr_speech_to_partial_ms`, excludes resolution and is *not* a substitute. |
| T0 resolution p99 < 15 ms | Same: in-extension, not exported. `make bench` is the gate. |
| Action dispatch p95 < 30 ms | Same. |
| Indexer throughput > 8 routes/min | Derivable from `wispr_indexer_routes_total`; no rule written yet. |
| Composition preview p95 < 1.2 s | `wispr_seed_plan_latency_ms` exists and is on the composer dashboard; no rule written yet. |

The pattern: **everything in the extension is unobservable in production.** That is a consequence
of the hot path being in-process with the DOM, which is the architecture's central bet. Closing it
means shipping a telemetry channel from the extension, which is its own decision — it would put a
network call in the one place the design says there is not one — and it has not been made.

---

## Moving this to GCP

`docs/GCP-DEPLOYMENT.md` targets GKE Autopilot. The collector config is deliberately shaped so
**only the `exporters` block changes**: receivers, processors and pipelines are identical, so what
is verified here is what runs there. Swap the `prometheus` exporter for `googlemanagedprometheus`
(or `prometheusremotewrite` at a hosted endpoint) and the rule files travel unchanged — they are
plain Prometheus rules.

Grafana's anonymous-admin setting in `docker-compose.yml` is local-only and must not travel. The
pilot uses Grafana Cloud or an IAP-fronted instance.
