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
| [dashboards/gateway.json](dashboards/gateway.json)   | `wispr_gateway_requests_total`, `wispr_gateway_request_duration_ms`, `wispr_tier_total`, `wispr_resolution_latency_ms`, `wispr_memory_snapshot_total`, `wispr_memory_snapshot_build_ms`, `wispr_seed_plan_latency_ms`, `wispr_seed_materialize_total`, `wispr_drift_reports_total`, `wispr_drift_decisions_total`, `wispr_index_jobs_enqueued_total`, `wispr_index_progress_events_total`, `wispr_index_progress_subscribers`, `wispr_false_execution_total` | `apps/gateway/src/telemetry/metrics.ts`   |
| [dashboards/indexer.json](dashboards/indexer.json)   | `wispr_indexer_routes_total`, `wispr_indexer_route_duration_ms`, `wispr_indexer_jobs_total`, `wispr_indexer_job_duration_ms`, `wispr_indexer_elements_total`, `wispr_indexer_edges_total`, `wispr_indexer_entity_schemas_total`, `wispr_indexer_field_specs_total`, `wispr_indexer_materializers_total`, `wispr_indexer_drift_reconciles_total`, `wispr_indexer_drift_reconcile_duration_ms`, `wispr_indexer_drift_alias_migration_rate`                     | `apps/indexer/src/telemetry/metrics.ts`   |
| [dashboards/composer.json](dashboards/composer.json) | `wispr_seed_plan_latency_ms`, `wispr_tier_total`, `wispr_compose_outcome_total`                                                                                                                                                                                                                                                                                                                                                                              | `apps/composer/src/composer/telemetry.py` |

`wispr_seed_plan_latency_ms` and `wispr_tier_total` are emitted by **both** the
gateway and the composer. Filter on `service_name` or the dashboard will double-count.
Each dashboard's queries include that filter.

## What is not emitted (do not alert on these)

Authoritative table: `docs/runbooks/README.md` § "Alerts that cannot fire yet".

| Series named in ARCHITECTURE § 7 | Status                                                                                                                                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wispr_speech_to_reticle_ms`     | **Does not exist.** Build-time benchmark only (`apps/extension/test/bench/speech-to-reticle.bench.ts`). Nearest runtime series is `wispr_speech_to_partial_ms` on the extension, forwarded through the service worker, and it excludes resolution. |
| `wispr_memory_staleness_hours`   | **Does not exist.** Computable from `screens.indexed_at` / `memory_versions.created_at` in Postgres.                                                                                                                                               |
| `wispr_drift_open_total`         | **Does not exist under this name.** What shipped is `wispr_drift_reports_total` (counter of raises) and `wispr_drift_decisions_total`. Queue depth is a SQL count of `drift_reports` where status is open.                                         |
| `wispr_false_execution_total`    | **Instrument exists, no production call site.** The panel is on the gateway dashboard so a future increment is visible. A zero here today means "nobody called `.add()`", not "no false executions".                                               |

No alert rule files are shipped for the three § 7 alerts. A rule that pages on a
series that is never written is a silent page that never fires, which is worse
than no rule.

## Import

Grafana → Dashboards → New → Import → upload the JSON. Datasource uid is
`prometheus`. Change it if yours is different.
