# Runbook — Seed materializer failing across a tenant

Test data creation is failing for every entity in a tenant, or falling back to the slowest adapter
everywhere.

## What exists today

**Phases 14, 15 and 16 are complete.** The composer plans, the gateway executes through a
three-adapter fallback chain, the ledger records every write, and a tester approves a preview
before anything is created. Every step below is live.

| Piece | Where | State |
|-------|-------|-------|
| `seed_ledger`, `materializers` tables | `db/migrations/20260725120000_core_schema.sql` | Written on every execute and revert |
| `CompositionPlan`, `SeedLedgerEntry`, `InverseOperation`, `MaterializationResult`, `MaterializerKind`, `ProvenanceEntry` | `packages/protocol/src/data.ts`, `composition.ts` | Producer and consumer both live |
| Constraint parser, value sampler, derived-field and conflict logic | `apps/composer/src/composer/parsing/`, `solving/` | Live behind `POST /compose` |
| Learned schemas to compose against | `entity_schemas`, `field_specs`, written by the indexer's observers | Populated by a crawl |
| Seed routes | `apps/gateway/src/routes/seed.ts` | `/v1/seed/plan`, `/v1/seed/execute`, `/v1/seed/revert` |
| The fallback chain and its three adapters | `apps/gateway/src/materializers/` — `chain.ts`, `api.ts`, `fixture.ts`, `ui.ts` | Ordered, with the verification lifecycle that demotes an adapter that stopped working |
| Preview, approval gate, class-S wiring | `apps/extension/src/seed/` | The approval is the only path to a write |
| `wispr_seed_plan_latency_ms`, `wispr_seed_materialize_total{adapter,outcome}` | `apps/gateway/src/telemetry/metrics.ts` | **Live call sites** in `routes/seed.ts` |
| `COMPOSER_URL` | `apps/gateway/src/config.ts` | Validated at boot; the gateway and composer are wired |

Two limits are deliberate, and both are recorded in
[ADR 0016](../adr/0016-writes-go-through-the-indexer.md):

- **An API observed behind a bearer token cannot be replayed**, because the token was never
  captured. The chain demotes to the UI adapter, which is correct but slow — see *Confirm* step 3
  before concluding the API adapter is broken.
- **A failed materializer is demoted but no re-crawl is queued**, because crawl bounds are not
  stored per application. Re-learning a materializer is a manual crawl.

---

## Symptoms

- `wispr_seed_materialize_total{outcome="failed"}` rising across every `adapter` label for one
  tenant.
- `wispr_seed_materialize_total{adapter="ui"}` dominating. The chain reached its last resort
  everywhere — the API and fixture adapters are failing or unverified. Seeds still succeed, at
  3–15 s each instead of 100–400 ms, and **the test coverage changed**: a record created through
  the UI exercised client-side validation, one created through the API did not.
- `wispr_seed_plan_latency_ms` p95 above the 1.2 s budget from `CLAUDE.md`, or the metric going
  silent entirely — the composer is unreachable rather than slow.
- Gateway 5xx/4xx concentrated on the seed routes with `materialization_failed` (502) or
  `materializer_unavailable` (501).
- Testers reporting the seed preview shows "cannot be reverted" on entities that used to be
  revertible. `inverse_op` degrading to `{"kind":"none"}` means the indexed delete flow stopped
  resolving.

---

## Confirm

### 1. Does the tenant have anything to compose from?

This is the first question in every seeding failure, and it is answerable now:

```sql
SELECT es.entity_name,
       es.observed_count,
       es.confidence,
       count(fs.id) AS fields,
       count(*) FILTER (WHERE fs.required) AS required_fields
FROM entity_schemas es
LEFT JOIN field_specs fs ON fs.entity_schema_id = es.id AND fs.tenant_id = es.tenant_id
WHERE es.memory_version_id = '<active-version-id>'
GROUP BY es.entity_name, es.observed_count, es.confidence
ORDER BY es.confidence;
```

A low `confidence` or a small `observed_count` is the cause of `schema_confidence_too_low` (422),
which is a **learning** failure, not a materialization failure. The fix is a better crawl, not a
better adapter. `entity_schemas` with zero rows means the observers ran and learned nothing — work
[indexer-failure.md](indexer-failure.md), not this runbook.

### 2. What materializers exist, and are any of them verified?

```sql
SELECT es.entity_name,
       m.kind,
       m.priority,
       m.verified_at,
       m.verification_ttl_hours,
       m.verified_at + (m.verification_ttl_hours * interval '1 hour') < now() AS expired
FROM materializers m
JOIN entity_schemas es ON es.id = m.entity_schema_id AND es.tenant_id = m.tenant_id
WHERE m.tenant_id = '<tenant-id>'
ORDER BY es.entity_name, m.priority;
```

Three things to read here:

- **`verified_at IS NULL` means never verified**, and the schema comment states the rule: such a
  materializer *may not run ahead of the UI adapter*, because "a stale replay silently tests
  nothing." An unverified API adapter is not a working API adapter.
- **`verification_ttl_hours` defaults to 168** — one week. An API materializer past its TTL drops
  below UI in priority until re-verified, so a tenant that has not been re-crawled in over a week
  will show UI-everywhere and that is the system behaving correctly.
- `materializers_schema_kind_key` is `UNIQUE (entity_schema_id, kind)`, so there is at most one
  adapter of each kind per entity. A missing row is a missing capability, not a misconfiguration.

### 3. Is seeding blocked by environment policy rather than broken?

```sql
SELECT id, name, env, base_url FROM applications WHERE tenant_id = '<tenant-id>';
```

`applications_env_check` restricts `env` to `development`, `staging`, `production`, and the schema
comment says why the column is not free text: *"Seeding policy keys off this column: production is
blocked unless auditably enabled."* A tenant-wide seeding failure on an application whose `env` is
`production` is very likely `seeding_forbidden` (403) working as designed —
`docs/ARCHITECTURE.md § 8` has production defaulting to seeding disabled with an explicit, audited
opt-in.

Check the audit trail before assuming a bug:

```sql
SELECT actor, action, target, metadata, created_at
FROM audit_log
WHERE tenant_id = '<tenant-id>' AND action LIKE 'seed%'
ORDER BY created_at DESC LIMIT 50;
```

**Every** seeding attempt is logged in the route, including refused ones.
A tenant-wide failure with no audit rows means the requests are not reaching the route at all.

### 4. Distinguish a composition failure from a materialization failure

The error taxonomy already draws this line, and it is the most useful triage in this runbook
(`apps/gateway/src/errors.ts`):

| Code | Status | Stage | Means |
|------|--------|-------|-------|
| `constraint_unsatisfiable` | 422 | compose | The constraint set cannot be satisfied against the schema. A well-formed request the system cannot fulfil — not a malformed one |
| `schema_confidence_too_low` | 422 | compose | Not enough was learned about this entity to compose safely |
| `reference_target_missing` | 422 | compose | A referenced record does not exist in the application |
| `uniqueness_exhausted` | 409 | compose | No unique value left to generate for a constrained field |
| `materializer_unavailable` | 501 | materialize | No adapter can handle this plan — the chain has no members |
| `materialization_failed` | 502 | materialize | An adapter ran and the write failed |
| `seeding_forbidden` | 403 | policy | Environment policy refused before anything ran |

**A tenant-wide failure that is all 422s is a learning problem.** All 501s means no materializers
are registered. All 502s means the adapters exist and the application is rejecting the writes.

### 5. What did the ledger record?

```sql
SELECT entity, adapter_used, inverse_op->>'kind' AS inverse_kind,
       count(*), max(created_at) AS latest
FROM seed_ledger
WHERE tenant_id = '<tenant-id>' AND reverted_at IS NULL
GROUP BY entity, adapter_used, inverse_op->>'kind'
ORDER BY latest DESC;
```

`inverse_op` is `NOT NULL` and `{"kind":"none","reason":…}` is a real, valid answer — the schema
comment requires it to be shown in the preview *before* creating. A rising count of `none` is a
tenant accumulating records nobody can remove, which is the adoption gate in
`docs/TEST-DATA-ENGINE.md § 5` failing quietly.

`seed_ledger_tenant_outstanding_idx` is a partial index on `(tenant_id, created_at) WHERE
reverted_at IS NULL`, built for exactly this query and for a tenant-wide revert.

### 6. Is the composer up?

Today: **you cannot tell.** There is no `/healthz` and no `/readyz` on the composer, no OTel, and
`GET /healthz` and `GET /readyz` (`apps/composer/src/composer/routes.py`), plus
`wispr_seed_plan_latency_ms`, `wispr_tier_total` and `wispr_compose_outcome_total` from
`telemetry.py`. Note that the first two are emitted by the **gateway as well**: the gateway measures
the round trip a tester waits on, the composer measures its own share, and aggregating them without
a `service` dimension double-counts.

---

## Immediate mitigation

**Priority: keep the tester able to work, and do not leave records nobody can revert.**

### Seeding failing is not an outage

The tester falls back to what they did before WisprTest: navigate the create form by hand. Nothing
about a seeding failure impairs resolution, execution or memory. Do not detach the extension.

### Never work around a refused write

`seeding_forbidden` on a production application is the guard working. Enabling seeding in
production to clear a ticket is a decision with an audit trail and a blast radius, and it is not an
operator's call to make at speed. `docs/ARCHITECTURE.md § 8` requires an explicit, audited opt-in
per application.

### If the API adapter is failing, let the chain fall back

That is the design: `fixture → api → ui → surface the failure with the concrete reason`. A failing
API adapter is **marked unverified** by the verification lifecycle and the chain falls to UI. Do not
disable it manually — the TTL mechanism already demotes it, and disabling discards the record of why.

> ⚠️ **No re-crawl is queued for a demoted materializer.** The chain demotes and stops there;
> nothing re-observes the endpoint automatically, because crawl bounds are not stored per
> application. Recovering an API adapter means someone enqueues a crawl by hand. This is deliberate
> and recorded in [ADR 0016](../adr/0016-writes-go-through-the-indexer.md) — it is the single
> likeliest reason a tenant sits on the slow UI path for weeks without anybody noticing.

**Tell the testers the adapter changed.** This is not cosmetic. `docs/TEST-DATA-ENGINE.md § 4` is
explicit: *"Never silently degrade without telling the tester which adapter ran — it changes what
the test actually covered."* A tester who believes they exercised the create form, and did not,
has a false result.

### Revert what should not stay

```sql
-- Read first: what is outstanding for this tenant, and can it be undone?
SELECT id, entity, external_ref, adapter_used, inverse_op->>'kind' AS inverse_kind, created_at
FROM seed_ledger
WHERE tenant_id = '<tenant-id>' AND reverted_at IS NULL
ORDER BY created_at DESC;
```

Revert through `POST /v1/seed/revert` when it exists — **never** by setting `reverted_at` by hand.
The column records that the inverse operation ran; writing it without running the inverse leaves
the record in the customer's application and the ledger claiming it is gone, which is worse than
either state alone. `seed_ledger_reverted_after_created` will accept the lie.

Multi-entity graphs revert in **reverse dependency order**, which is what `plan_id` and `node_id`
are for (`seed_ledger_plan_node_key UNIQUE (plan_id, node_id)`). Reverting one node of a graph by
hand will fail on referential integrity in the customer's application, and it will fail
half-way.

---

## Root-cause investigation

**Every adapter failing for one tenant.** Start with authentication, not with the adapters. The API
adapter reuses the tester's live session from the attached tab, and the UI adapter drives the real
form; WisprTest stores no credentials for the application under test
(`docs/ARCHITECTURE.md § 8`). An expired session breaks both at once and looks like a systemic
adapter failure. The same cause produces `auth_failed` on the indexer side — cross-check
[indexer-failure.md](indexer-failure.md) for whether crawls are failing too.

**UI everywhere, suddenly.** Almost always TTL expiry rather than breakage. Query 2 above shows it
directly. The secondary cause is a re-index: `materializers` hangs off `entity_schemas`, which
hangs off `memory_version_id`, so **a new memory version starts with no verified materializers at
all** until the crawl re-observes them. A tenant that was just re-indexed will show exactly this
pattern and will recover on its own.

**`materializer_unavailable` (501) for every entity.** No materializer rows exist for that memory
version. The observers did not find a create path — check whether the crawl reached the create
forms at all (`wispr_indexer_materializers_total`), and whether the never-interact selector list on
the job excluded them.

**Composition failing rather than materialization.** `constraint_unsatisfiable` in bulk usually
means the learned schema disagrees with the application's real validation. The composer works from
statistics, never values ([ADR 0009](../adr/0009-structure-not-content.md)), so it cannot reproduce
format quirks the application enforces, and `docs/TEST-DATA-ENGINE.md` accepts this: seeded data is
plausible per field, not jointly realistic. A field whose real constraint is a checksum or a
cross-field rule will fail every time and no adapter change fixes it.

**`inverse_op` degrading to `none`.** The inverse is derived from an **indexed delete flow**. If
that flow moved or was relabelled, the derivation fails and every new entry is unrevertible. This
is drift, arriving through the seeding path — see [drift-backlog.md](drift-backlog.md).

**Plan latency above 1.2 s.** The composer is stateless and does no IO
([ADR 0010](../adr/0010-python-confined-to-composer.md)), so latency there is solver work, not a
dependency. A constraint set that triggers heavy search on a wide schema is the likely cause. If
the metric is *absent* rather than high, the gateway is not reaching the composer at all — and note
that as of today there is no configured route between them to fail.

**Logs will not show you the payload.** `apps/gateway/src/logger.ts` redacts by key, and `payload`
and `value` are both on the list. They are exactly the fields you want during a materialization
investigation and they will read `[redacted]`. That is
[ADR 0009](../adr/0009-structure-not-content.md) working as intended. Do not add a carve-out; add a
more specific field name to the log call.

---

## Prevention

- **Alert on a demoted materializer, not just on failures.** Nothing re-crawls a demoted adapter
  (ADR 0016), so a tenant can sit on the UI path indefinitely with every seed *succeeding*. Watch
  `materializers.verified_at` going stale, not only the error rate.
- **Alert on `wispr_seed_materialize_total{adapter,outcome}`.** The instrument is live. The
  alert that matters is not "failures" — it is **a shift in the `adapter` distribution**, because a
  silent slide to UI changes what the tests cover without failing anything.
- **Alert on materializer verification expiry before it bites.** `verified_at +
  verification_ttl_hours` is computable today and predicts the UI-everywhere failure a week ahead.
- **Alert on outstanding unrevertible records.** `count(*) WHERE reverted_at IS NULL AND
  inverse_op->>'kind' = 'none'`, per tenant. Testers will not adopt a tool that quietly fills
  staging with garbage, and this number is the adoption gate made measurable.
- **Keep the adapter visible in the HUD, permanently.** It will be proposed as clutter. It is the
  difference between a test that exercised the customer's validation and one that did not.
- **Do not add automatic retry across adapters beyond the specified chain.** Each adapter attempt
  is a write against a customer's application. A retry loop that partially succeeds produces
  duplicate records with no ledger entry — the one failure mode that costs more trust than not
  seeding at all.
