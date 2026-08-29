# Grafana dashboards

Dashboards-as-code for instruments that **already exist in the source**. Nothing here
invents a time series.

There is no Grafana, no Prometheus, and no OTLP collector in `docker-compose.yml` or
in the kind chart. Services create the instruments either way; they export only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set (see `.env.example`). Import these JSON files
into a Grafana that already has a Prometheus (or Grafana Cloud) datasource named
`prometheus` once a collector is actually wired.

OpenTelemetry → Prometheus name mapping is not stable across SDK versions. The
queries use the instrument names from `apps/gateway/src/telemetry/metrics.ts`,
`apps/indexer/src/telemetry/metrics.ts` and `apps/composer/src/composer/telemetry.py`.
If a panel is empty, check the collector for a `_total` suffix, a unit suffix, or a
`service_name` label before assuming the process is down.

## What is emitted

| Dashboard                                            | Instruments                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Source                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| [dashboards/gateway.json](dashboards/gateway.json)   | HTTP, tiers, snapshots, seed, drift counters, index progress, `wispr_false_execution_total` (no producer). Gauges `wispr_drift_open_total` / `wispr_memory_staleness_hours` exist in code; **not on this dashboard yet**. | `apps/gateway/src/telemetry/metrics.ts` |
| [dashboards/indexer.json](dashboards/indexer.json)   | `wispr_indexer_routes_total`, `wispr_indexer_route_duration_ms`, `wispr_indexer_jobs_total`, `wispr_indexer_job_duration_ms`, `wispr_indexer_elements_total`, `wispr_indexer_edges_total`, `wispr_indexer_entity_schemas_total`, `wispr_indexer_field_specs_total`, `wispr_indexer_materializers_total`, `wispr_indexer_drift_reconciles_total`, `wispr_indexer_drift_reconcile_duration_ms`, `wispr_indexer_drift_alias_migration_rate`                     | `apps/indexer/src/telemetry/metrics.ts`   |
| [dashboards/composer.json](dashboards/composer.json) | `wispr_seed_plan_latency_ms`, `wispr_tier_total`, `wispr_compose_outcome_total`                                                                                                                                                                                                                                                                                                                                                                              | `apps/composer/src/composer/telemetry.py` |

`wispr_seed_plan_latency_ms` and `wispr_tier_total` are emitted by **both** the
gateway and the composer. Filter on `service_name` or the dashboard will double-count.
Each dashboard's queries include that filter.

## What is not yet useful for paging

Authoritative table: `docs/runbooks/README.md` § "Alerts that cannot fire yet", and
`docs/STATUS.md`.

| Series named in ARCHITECTURE § 7 | Status |
| -------------------------------- | ------ |
| `wispr_speech_to_reticle_ms`     | **Does not exist at runtime.** Build-time benchmark only. Nearest runtime series is `wispr_speech_to_partial_ms`. |
| `wispr_memory_staleness_hours`   | **Gauge is emitted** from Postgres. Not on these dashboards yet. No collector in Compose/kind. |
| `wispr_drift_open_total`         | **Gauge is emitted.** Raise counters still exist. Not on these dashboards yet. |
| `wispr_false_execution_total`    | **Instrument exists, no production call site.** A zero here means "nobody called `.add()`". |

No alert rule files are shipped. A rule that pages on a series that is never exported is a
silent page that never fires, which is worse than no rule.

## Import

Grafana → Dashboards → New → Import → upload the JSON. Datasource uid is
`prometheus`. Change it if yours is different.
