# Grafana dashboards

Dashboards-as-code for instruments that **already exist in the source**. Nothing here
invents a time series.

`make obs-up` starts a collector, Prometheus and Grafana (compose profile `observability`)
and **provisions these dashboards and the `prometheus` datasource automatically** — there is
nothing left to import by hand. Services still create the instruments either way and export
only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (see `.env.example`); `make obs-up` prints the
line to add. See [docs/runbooks/observability.md](../../docs/runbooks/observability.md).

The kind chart still has no collector — it is documented, not deployed.

OpenTelemetry → Prometheus name mapping is not stable across SDK versions, and the queries
use the instrument names exactly as declared in `apps/gateway/src/telemetry/metrics.ts`,
`apps/indexer/src/telemetry/metrics.ts` and `apps/composer/src/composer/telemetry.py`. Two
settings in `infra/otel/collector.yaml` are what keep that true, and neither is cosmetic:

- `add_metric_suffixes: false` — the instruments are already named `..._total`, and histograms
  are already named `..._ms` with `unit: 'ms'`. Left at the default, the exporter appends its
  own and you get `wispr_gateway_requests_total_total`.
- `resource_to_telemetry_conversion: enabled` — puts `service_name` on the series as a label
  rather than only on a separate `target_info` metric. Load-bearing, because
  `wispr_seed_plan_latency_ms` and `wispr_tier_total` are emitted by _both_ the gateway and the
  composer, and without the label the two silently sum.

If a panel is empty, check those two before assuming the process is down.

## What is emitted

| Dashboard                                            | Instruments                                                                                                                                                                                                                                                                                                                                                                                                                              | Source                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| [dashboards/gateway.json](dashboards/gateway.json)   | HTTP, tiers, snapshots, seed, drift counters, index progress, `wispr_false_execution_total` (produced since PR #42). Gauges `wispr_drift_open_total` / `wispr_memory_staleness_hours` are alerted on; **not on this dashboard yet**.                                                                                                                                                                                                     | `apps/gateway/src/telemetry/metrics.ts`   |
| [dashboards/indexer.json](dashboards/indexer.json)   | `wispr_indexer_routes_total`, `wispr_indexer_route_duration_ms`, `wispr_indexer_jobs_total`, `wispr_indexer_job_duration_ms`, `wispr_indexer_elements_total`, `wispr_indexer_edges_total`, `wispr_indexer_entity_schemas_total`, `wispr_indexer_field_specs_total`, `wispr_indexer_materializers_total`, `wispr_indexer_drift_reconciles_total`, `wispr_indexer_drift_reconcile_duration_ms`, `wispr_indexer_drift_alias_migration_rate` | `apps/indexer/src/telemetry/metrics.ts`   |
| [dashboards/composer.json](dashboards/composer.json) | `wispr_seed_plan_latency_ms`, `wispr_tier_total`, `wispr_compose_outcome_total`                                                                                                                                                                                                                                                                                                                                                          | `apps/composer/src/composer/telemetry.py` |

`wispr_seed_plan_latency_ms` and `wispr_tier_total` are emitted by **both** the
gateway and the composer. Filter on `service_name` or the dashboard will double-count.
Each dashboard's queries include that filter.

## What is not yet useful for paging

Authoritative table: `docs/runbooks/README.md` § "Alerts that cannot fire yet", and
`docs/STATUS.md`.

| Series named in ARCHITECTURE § 7 | Status                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wispr_speech_to_reticle_ms`     | **Does not exist at runtime.** Build-time benchmark only. Nearest runtime series is `wispr_speech_to_partial_ms`.                                                                                                                                                                         |
| `wispr_memory_staleness_hours`   | **Gauge is emitted** from Postgres, and alerted on (`WisprMemoryStale`).                                                                                                                                                                                                                  |
| `wispr_drift_open_total`         | **Gauge is emitted**, and alerted on (`WisprDriftBacklogStuck`).                                                                                                                                                                                                                          |
| `wispr_false_execution_total`    | **Produced.** `POST /v1/sessions/:id/false-executions` increments it, filed from the console timeline and from the HUD. With `wispr_false_execution_withdrawn_total` and `wispr_session_steps_total{outcome}` it forms the release gate, alerted on as `WisprFalseExecutionRateBreached`. |

Alert rules are in [`infra/prometheus/rules/wispr.yml`](../prometheus/rules/wispr.yml) and
every one of them fires on a series that is actually exported. What is still **not** alertable
is everything inside the extension — the speech-to-reticle, T0 and dispatch budgets all live in
the tester's browser, which has no exporter. `docs/runbooks/observability.md` §
"What still cannot be alerted on" is the honest table.

## Import

Nothing to import: `make obs-up` provisions these from disk
(`infra/grafana/provisioning/`). They are read-only in the UI on purpose — a panel edited in
the browser and not committed survives until the next restart and then vanishes.

To load them into a Grafana you already have, upload the JSON and point it at a Prometheus
datasource with uid `prometheus`.
