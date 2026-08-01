# Runbook — Indexer failure

Crawl jobs are failing, stalling, or leaving memory versions stuck in `building`.

## What exists today

All of it. The indexer is complete through Phase 13 (`apps/indexer/`), and every table, key,
metric, log field and failure code named below is in the source at `81b786c`.

Two things are **not** built and change what you can do:

- **Nothing enqueues jobs but tests.** `JobStream.publish()` is documented as "used by the gateway
  in later phases, and by this service's own tests." There is no `POST /v1/applications` and no
  `/v1/jobs` route in `apps/gateway/src/routes/`. In production today, jobs arrive by something
  writing to the Redis stream directly.
- **There is no alerting.** `infra/` is empty. Every metric below is emitted over OTLP and
  nothing scrapes it.

---

## Symptoms

- A tester reports the extension attaches but resolves nothing. The gateway returns
  `memory_snapshot_unavailable` (503) from `GET /v1/memory/:appId/snapshot` — there is no `active`
  memory version for the application.
- The console's indexing view stops updating mid-crawl (once Phase 18 exists; today, the progress
  stream simply stops growing).
- `wispr_indexer_jobs_total{outcome="failed"}` rising, with a `code` label.
- `wispr_indexer_jobs_total{outcome="cancelled"}` rising with no matching `completed` — jobs are
  being reclaimed in a loop and never finishing.
- `wispr_indexer_routes_total{outcome="skipped"}` dominating `indexed` — the crawl is running and
  learning almost nothing.
- Indexer `/readyz` returning 503, or `/healthz` reporting `busy:true` indefinitely.

---

## Confirm

### 1. Is a memory version stuck, and why?

```sql
SELECT mv.id, mv.application_id, a.name, mv.version, mv.status,
       mv.failure_reason, mv.created_at, mv.updated_at
FROM memory_versions mv
JOIN applications a ON a.id = mv.application_id AND a.tenant_id = mv.tenant_id
WHERE mv.status IN ('building', 'failed')
ORDER BY mv.updated_at DESC;
```

`failure_reason` is written as `"<code>: <detail>"` by `failMemoryVersion`, where `<code>` is an
`IndexFailureCode` and `<detail>` is a PII-free one-liner. The codes, from
`packages/protocol/src/indexing.ts`:

| Code | Meaning | Usually means |
|------|---------|---------------|
| `bounds_invalid` | The job's crawl bounds were missing or unusable | A malformed job payload — the crawl *refuses to start* without allowlist, depth cap and page cap |
| `ssrf_rejected` | A target URL failed the allowlist or resolved to a private address | Application `base_url` changed, or a redirect left the allowlist |
| `auth_failed` | Form login or `storageState` did not produce a session | Credentials rotated, login form changed, MFA introduced |
| `secret_unavailable` | The tenant's secret reference could not be resolved | Secret manager unreachable or the reference is stale |
| `browser_failed` | Playwright could not launch or crashed — **also the catch-all for any unexpected throw** | Resource limits, missing browser binary, or a genuine bug |
| `navigation_failed` | A route would not load or settle | Application down, or a route that hangs |
| `budget_exhausted` | Depth cap, page cap or rate limit reached | Bounds too tight, or the app is bigger than expected |
| `persistence_failed` | Writing screens/elements/edges to Postgres failed | Database issue, or a constraint violation from bad extraction |
| `cancelled` | The worker shut down mid-crawl | A deploy. **Not a failure** — see below |

`browser_failed` being the catch-all matters: `failureCodeOf` returns it for any non-`IndexerError`
throw. A `browser_failed` with a `detail` that does not mention the browser is a bug, not a
resource problem.

### 2. Is `building` stuck, or just slow?

A `building` version is normal during a crawl. It is stuck if `updated_at` has not moved and no
worker holds the job. Check the stream:

```bash
redis-cli XINFO GROUPS wispr:indexer:jobs
redis-cli XPENDING wispr:indexer:jobs indexers - + 20
```

The stream key is `wispr:indexer:jobs` — `INDEXER_JOB_STREAM` (`indexer:jobs`) prefixed by the
`wispr` namespace applied in code by `namespacedKey()`, *not* by ioredis `keyPrefix`. The consumer
group is `INDEXER_CONSUMER_GROUP` (`indexers`).

`XPENDING` shows entries and their idle time. An entry idle for longer than
`INDEXER_CLAIM_MIN_IDLE_MS` (120 s locally) should be reclaimed by the next `XAUTOCLAIM` on any
worker's loop. If it is idle far beyond that and nobody claims it, no worker is running or every
worker is busy.

### 3. Is a worker alive and taking work?

```bash
curl -s http://<indexer-host>:8081/healthz   # {"status":"ok","busy":true|false}
curl -s http://<indexer-host>:8081/readyz    # 503 names the failing dependency
```

`/readyz` checks Postgres and Redis and reports each. `busy` is what makes a rolling deploy
legible: a draining node shows `busy:true` until its crawl finishes.

### 4. Read the logs

Filter on `service:"wispr-indexer"` (`OTEL_SERVICE_NAME`) and the `event` field:

- `worker.listening` — the loop is up and blocking on `XREADGROUP`
- `worker.read_failed` — Redis is refusing reads
- `worker.job_invalid` — a message did not parse as `CrawlJob`; it was acked and dropped, with
  `issues` naming the offending fields
- `worker.job_requeued` — a job was cancelled and left pending for reclaim
- `job.started` / `job.completed` / `job.failed` (`code`, `detail`, `duration_ms`)
- `job.fail_write_failed` — **the failure could not be recorded on the memory version.** The
  version is still `building` and `failure_reason` is null; the log line is the only record
- `checkpoint.failed` — the frontier could not be saved; the crawl still works, resume is wider
- `progress.publish_failed` — a progress event was dropped; cosmetic

Every job line carries `tenant_id`, `job_id` and `application_id`.

### 5. What is a running crawl actually doing?

```bash
redis-cli XRANGE wispr:tenant:<tenant-id>:indexer:progress:<job-id> - + COUNT 50
```

Events carry a monotonic per-job `sequence`, so a gap means a dropped delivery. The stream is
capped at `INDEXER_PROGRESS_MAXLEN` (10 000).

---

## Immediate mitigation

**Priority: get the tester a working memory version. That means an `active` one, not a correct one.**

### The previous version is still there

Activation is a flip, and `memory_versions_one_active_per_application` is a partial unique index
allowing at most one `active` row per application. A failed crawl does not remove the previously
active version — check before doing anything drastic:

```sql
SELECT version, status, created_at FROM memory_versions
WHERE application_id = '<app-id>' ORDER BY version DESC;
```

If an older `active` version exists, testers are already being served it and this is not a
tester-facing outage. Fix the crawl on normal hours.

### A stuck `building` version blocking a re-crawl

`openMemoryVersion` adopts an existing `building` version rather than creating a new one, so a
resumed job continues into it. That is the designed behaviour and usually what you want. If a
`building` version is genuinely abandoned (the job is not in `XPENDING` and no worker holds it),
either re-enqueue the job so a worker adopts it, or mark it failed so the state is honest:

```sql
UPDATE memory_versions
SET status = 'failed', failure_reason = 'cancelled: abandoned, marked by operator'
WHERE id = '<memory-version-id>' AND status = 'building';
```

The `memory_versions_failure_reason_check` constraint requires `failure_reason` to be non-null
exactly when `status = 'failed'`, so the reason is not optional.

### A poison job cycling the queue

If `worker.job_invalid` repeats, the producer is writing malformed jobs. The worker already acks
and drops them, so the queue does not block. Fix the producer.

### A worker wedged mid-crawl

Restart it. Cancellation is safe by design: a cancelled job is **not** acknowledged, the entry
stays pending, and another worker reclaims it after `INDEXER_CLAIM_MIN_IDLE_MS` and resumes from
the checkpoint at `wispr:tenant:<tenant-id>:indexer:checkpoint:<job-id>`. A crash loses at most
the route in flight.

### Do not retry an `auth_failed` job in a loop

`runJob` acknowledges a failed job and nothing retries automatically, deliberately: *"a crawl that
failed on authentication will fail again, and a retry loop against a customer's login form is how
you get an account locked."* Fix the credentials first.

---

## Root-cause investigation

**`auth_failed` / `secret_unavailable`** — the two most common in practice. Credentials rotate,
login forms change, MFA gets introduced. Credentials are resolved at crawl time and never stored
(`apps/indexer/src/crawl/secrets.ts`), so there is nothing cached to be stale on our side; the
reference or the secret behind it is wrong. `storageState` blobs captured by a tester expire.

**`ssrf_rejected`** — `apps/indexer/src/crawl/url-policy.ts` validates every target against the
application's allowlist and rejects private IP ranges and non-`http(s)` schemes. `runJob` also
requires the job's base URL to agree with the origin registered on the `applications` row: *"The
job payload says where to crawl; the database says where this application is."* A legitimate
`ssrf_rejected` usually means the application moved, or an SSO redirect crosses to a host the
allowlist does not cover.

**`budget_exhausted`** — compare `wispr_indexer_routes_total{outcome="indexed"}` against the page
cap on the job. If the application genuinely has more routes than the cap, raise the cap on the
job; the caps are per-application knowledge and live on the job, not in `apps/indexer/src/config.ts`
(which holds no crawl configuration at all, by design — see
[ADR 0011](../adr/0011-learned-not-configured.md)).

**High `skipped` share** — `wispr_indexer_routes_total{outcome="skipped",reason=…}` carries the
reason. The metric exists precisely because "a crawl that silently skips half an application looks
identical to a small application unless the skips are counted."

**`persistence_failed`** — check for constraint violations. The likely candidates are
`elements_screen_key_key` (duplicate `element_key` within a screen) and the `element_key` CHECK
pattern, which requires exactly `screen.component.element` in lowercase with `_`/`-` separators.
A generator producing a fourth segment or an uppercase character fails here.

**Throughput below the 8 routes/min budget** — `wispr_indexer_route_duration_ms` divided into a
minute. One job runs at a time per process on purpose ("a crawl is browser-bound, not IO-bound"),
so throughput scales by replica count, not by concurrency inside a worker.

**Two workers fighting over one crawl** — check `INDEXER_WORKER_ID` is unique per replica. It has
no default and boot fails without it, precisely because "two workers silently sharing a generated
default would each claim the other's abandoned jobs." Also check `INDEXER_CLAIM_MIN_IDLE_MS` is
comfortably longer than the slowest route: too low and a live crawl gets reclaimed underneath
itself.

**A resumed crawl learning less than the first attempt** — this was a real bug, fixed in
`96ed813 fix(indexer): stop a resumed crawl from unlearning what the first attempt knew`. If it
recurs, that commit is the place to start.

---

## Prevention

- **Wire up alerting.** Phase 19 owns it. The signals that matter, in order:
  `wispr_indexer_jobs_total{outcome="failed"}` by `code`; a `building` memory version older than a
  few hours; `wispr_indexer_jobs_total{outcome="cancelled"}` without matching completions.
- **Alert on the derived staleness figure**, which is computable today even though
  `wispr_memory_staleness_hours` does not exist:

  ```sql
  SELECT a.name, mv.version,
         EXTRACT(EPOCH FROM (now() - max(s.indexed_at))) / 3600 AS staleness_hours
  FROM memory_versions mv
  JOIN applications a ON a.id = mv.application_id AND a.tenant_id = mv.tenant_id
  JOIN screens s ON s.memory_version_id = mv.id
  WHERE mv.status = 'active'
  GROUP BY a.name, mv.version;
  ```

- **Monitor secret and auth-profile expiry** before a crawl discovers it. `auth_failed` at 2 a.m.
  is a credential that expired at 2 a.m.
- **Keep `INDEXER_CLAIM_MIN_IDLE_MS` above the p99 route duration.** It is the single most
  dangerous indexer knob: too low reclaims live crawls, too high stalls the queue after a crash.
- **Never add automatic retry of failed jobs.** The current behaviour — ack and stop — is a
  deliberate protection against locking out a customer's account. If retries are ever added, they
  must exclude `auth_failed` and `secret_unavailable` explicitly.
- **Alert on `job.fail_write_failed`.** It is rare and it is the one case where the database and
  reality disagree: the crawl failed and the memory version does not say so.
