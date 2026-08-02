# Runbook — Drift backlog

Memory is going stale because drift reports are not being reviewed, or because nothing is
producing them.

## What exists today

**Phase 17 is unbuilt.** This is the runbook whose subject does not exist yet, and the honest
version of it is more useful than a confident one.

What is built:

| Piece | Where | State |
|-------|-------|-------|
| `drift_reports` table, with its constraints and the pending-review index | `db/migrations/20260725120000_core_schema.sql` | Exists, tested (`apps/gateway/test/db/schema.test.ts`), **nothing writes to it** |
| `DriftReport`, `StructuralDiff`, `DriftStatus`, `DriftDetector` contracts | `packages/protocol/src/drift.ts` | Exist, round-trip tested, **no producer and no consumer** |
| `structuralHash` computation on route settle | `apps/extension/src/runtime/state-engine.ts` | **Built and running.** The value is computed; nothing compares it to the snapshot |
| Degraded-mode resolution against drifted elements | `apps/extension/src/resolver/tier0.ts`, `candidate-binder.ts` | **Built.** An alias whose bound element no longer matches its stored fingerprint is discounted, pushing toward disambiguation instead of a confident wrong hit |
| `drift_approval_required` (409) | `apps/gateway/src/errors.ts` | In the taxonomy, never thrown |
| A `drift` tone in the HUD | `apps/extension/src/content/Hud.tsx` | Exists, used today for voice failures |

What is not built: there is no `apps/extension/src/drift/`, no `apps/indexer/src/drift/`, and no
`/v1/drift/*` route — `apps/gateway/src/routes/` contains `memory.ts`, `resolve.ts` and
`sessions.ts` and nothing else. No `wispr_drift_open_total` metric exists.

**So the alert that opens this runbook cannot fire.** Until Phase 17 lands, drift is real and
invisible: the application changes, memory does not, and the only signal is a tester saying
resolution got worse. The sections below are written against what Phase 17 will produce, and every
step that depends on it is marked. The parts that work **today** are the staleness query in
*Confirm*, the memory-version and alias queries, and all of *Immediate mitigation*.

---

## Symptoms

**Today, with Phase 17 unbuilt:**

- Testers report that phrases which used to work now open a disambiguation list. This is
  [ADR 0007](../adr/0007-human-approved-drift-only.md)'s degraded mode functioning correctly — the
  resolver discounted an alias whose element no longer matches — and it is currently the *only*
  drift signal the product produces.
- `wispr_tier_total{tier="T2"}` climbing as a share of the total. The compounding loop runs
  backwards when the application changes: phrases that were T0 stop matching and escalate again.
  `docs/ARCHITECTURE.md § 6` names tier distribution as the best health metric for the product, and
  this is what it looks like when memory has fallen behind.
- `wispr_resolution_latency_ms` rising at p50 for the same reason — more commands taking the
  800 ms path instead of the 15 ms one.
- The active `memory_version` for an application is weeks old while the customer deploys weekly.

**Once Phase 17 exists, additionally:**

- `drift_reports` rows in `open`, `reconciling` or `diffed` accumulating with no `resolved_at`.
- Reports whose `alias_migration_rate` is low — the tester's learned vocabulary is about to be
  lost on approval, and that is the number the approval screen is specified to lead with.
- The same `screen_id` producing repeated reports: the application is changing faster than anyone
  reviews it.

---

## Confirm

### 1. How stale is memory, per application?

Works today. `wispr_memory_staleness_hours` is named in `docs/ARCHITECTURE.md § 7` and does not
exist, but the underlying data does — `screens.indexed_at` and `memory_versions.created_at`:

```sql
SELECT a.name,
       mv.version,
       mv.created_at AS version_created,
       max(s.indexed_at) AS last_indexed,
       EXTRACT(EPOCH FROM (now() - max(s.indexed_at))) / 3600 AS staleness_hours
FROM memory_versions mv
JOIN applications a ON a.id = mv.application_id AND a.tenant_id = mv.tenant_id
JOIN screens s ON s.memory_version_id = mv.id
WHERE mv.status = 'active'
GROUP BY a.name, mv.version, mv.created_at
ORDER BY staleness_hours DESC;
```

`docs/BUILD-PLAN.md` Phase 19 names 48 hours as the warning threshold. Treat that as the number to
alert on when there is something to alert with.

### 2. Is the backlog real, and how old?

**Phase 17 required — this returns zero rows today.**

```sql
SELECT dr.status,
       count(*) AS reports,
       min(dr.created_at) AS oldest,
       avg(dr.alias_migration_rate) AS avg_alias_migration
FROM drift_reports dr
WHERE dr.tenant_id = '<tenant-id>'
  AND dr.status IN ('open', 'reconciling', 'diffed')
GROUP BY dr.status;
```

The statuses mean specific things (`packages/protocol/src/drift.ts`):
`open` → detected, nobody has looked; `reconciling` → the indexer has picked it up;
`diffed` → a `StructuralDiff` is attached and it is waiting on a human; `approved` / `rejected` →
terminal, and unreachable without a human on the record.

The distribution tells you which stage is stuck:

- Piling up in **`open`** — nothing is picking reports up. The indexer side of Phase 17 is down or
  not consuming.
- Piling up in **`reconciling`** — reconciliation crawls are failing. Cross-check against
  [indexer-failure.md](indexer-failure.md); a re-crawl is a crawl and fails the same ways.
- Piling up in **`diffed`** — the system did its job and no human is reviewing. This is the
  backlog [ADR 0007](../adr/0007-human-approved-drift-only.md) predicted, and it is a staffing
  problem, not a system problem.

### 3. Is a human actually blocked, or is the queue simply unattended?

```sql
SELECT status, approved_by, resolved_at, count(*)
FROM drift_reports
WHERE tenant_id = '<tenant-id>'
GROUP BY status, approved_by, resolved_at;
```

`drift_reports_decision_needs_approver` makes it impossible for a row to be `approved` or
`rejected` without both `approved_by` and `resolved_at`. If you find terminal rows with a null
approver, the constraint has been dropped and that is a much larger incident than a backlog — see
[ADR 0007](../adr/0007-human-approved-drift-only.md) on why that constraint is the decision.

### 4. What is the vocabulary loss going to be?

Aliases are the compounding asset ([ADR 0004](../adr/0004-tiered-resolution-and-alias-writeback.md)),
and they are what a memory version increment puts at risk:

```sql
SELECT source, count(*), sum(hits) AS total_hits
FROM aliases
WHERE tenant_id = '<tenant-id>' AND memory_version_id = '<active-version-id>'
GROUP BY source;
```

A tenant with thousands of `t2_writeback` aliases and a low `alias_migration_rate` on pending
reports is about to lose a lot of learned vocabulary. That is the argument for reviewing the
backlog now rather than next sprint, and it is more persuasive than "the queue is long".

### 5. Is the snapshot serving what you think it is?

```bash
redis-cli --scan --pattern 'wispr:tenant:<tenant-id>:memory:<app-id>:v*'
```

The key carries the version (`apps/gateway/src/routes/memory.ts`), so activating a new version does
not invalidate anything — it asks for a key nothing has written yet, and the old entry ages out on
its 3600 s TTL. Multiple `v*` keys for one application is normal, not a bug. An alias write-back
deletes its version's key explicitly.

---

## Immediate mitigation

**Priority: keep the tester working. Memory being stale is not an outage — the resolver is
designed for it.**

### Confirm degraded mode is actually degrading gracefully

This is the load-bearing behaviour, and it works today. `tier0.ts` discounts an alias or exact
match whose bound element no longer matches its stored fingerprint, so a drifted screen produces a
disambiguation list rather than a confident wrong click. If testers report *wrong* actions rather
than *more questions*, that is not a drift backlog — that is a false execution, and it is a far
more serious incident. See [ADR 0005](../adr/0005-reversibility-taxonomy.md).

### Re-index rather than wait for the review queue

The blunt instrument, available today and the only one available today: enqueue a full crawl. A new
crawl writes a new `memory_version` with status `building` and flips it to `active` on completion.
`memory_versions_one_active_per_application` is a partial unique index allowing one `active` row
per application, so the flip is atomic and the previous version keeps serving until it happens.

This is not equivalent to approving the backlog. A full re-index **replaces** memory rather than
diffing it, so:

- Nobody reviewed what changed. The audit trail that [ADR 0007](../adr/0007-human-approved-drift-only.md)
  exists to produce is not created.
- **Aliases do not migrate.** `aliases.memory_version_id` is part of the row and part of the
  uniqueness constraint; a new version starts with the aliases the crawl wrote and none of the
  `t2_writeback` vocabulary the tenant accumulated against the old one. The tenant re-learns its
  phrasing from scratch, at T2 prices.

Use it when memory is so stale that the tester cannot work. Do not use it as a way to drain a
review queue — that is auto-approval with extra steps, and it costs the tenant its vocabulary.

### Do not add an auto-approve path

Not as a flag, not as a "temporary" script, not as a bulk `UPDATE drift_reports SET status =
'approved'`. `drift_reports_decision_needs_approver` will force a `users` row and a timestamp onto
any such statement, which means an operator draining the queue this way is recording a human
decision that no human made. That is worse than the backlog. Read
[ADR 0007](../adr/0007-human-approved-drift-only.md) before reaching for it — it is written at
length precisely for the person standing here at 6 p.m. with forty reports.

---

## Root-cause investigation

**Reports pile up in `diffed`.** The system is working and nobody is reviewing. The causes, in
descending order of how often they will be the real one:

1. **Nobody owns the queue.** Drift review is a job. If it is not on somebody's board, it does not
   happen. This is an organisational finding and should be reported as one.
2. **The diffs are unreadable.** `StructuralDiff` carries `added`, `removed`, `moved`, `renamed`
   and `schemaChanges`; a diff with 200 entries because a design system shipped is not reviewable
   and will be rubber-stamped. Grouping and confidence-ordering are the fix, and
   [ADR 0007](../adr/0007-human-approved-drift-only.md) is explicit that approval fatigue is a
   product problem the decision forces into the open rather than solves.
3. **The customer deploys faster than review.** A team shipping daily generates drift daily. This
   is a capacity mismatch and no amount of tooling on our side changes it.

**Reports pile up in `open` or `reconciling`.** Reconciliation is a crawl. Work
[indexer-failure.md](indexer-failure.md) — the failure codes, the `XPENDING` check and the
`auth_failed` guidance all apply unchanged.

**One screen produces repeated reports.** Either the region genuinely changes on every deploy — a
dashboard with generated ids, a table whose column order depends on data — or `structuralHash` is
picking up something it should not. `packages/fingerprint/src/structural-hash.ts` is the single
implementation ([ADR 0002](../adr/0002-single-fingerprint-implementation.md)); a hash that is
unstable across identical renders is a bug there and affects the indexer and the extension
identically.

**Staleness with no reports at all, once Phase 17 exists.** Detection is not running. Check that
the extension is attached and reaching route settle — `structuralHash` is recomputed there
(`state-engine.ts`), and a screen no tester visits produces no detection. Screens covered only by
the indexer's own re-crawls, not by live traffic, are a permanent blind spot in extension-side
detection; that is why `DriftDetector` has an `indexer` member.

**A low `alias_migration_rate` across many reports.** Fingerprints stopped matching wholesale,
which usually means a framework or design-system upgrade changed roles, landmarks or generated
ids rather than the application changing meaning. The weights in
`packages/fingerprint/src/config.ts` are config for this reason — but retuning them changes both
consumers at once, so treat it as a fingerprint change and not as a drift fix.

---

## Prevention

- **Build the alert when Phase 17 lands.** `wispr_drift_open_total` is named in
  `docs/ARCHITECTURE.md § 7` and does not exist. Age matters more than count: a queue of forty
  reviewed within a day is healthy, a queue of three untouched for two weeks is not.
- **Alert on staleness now.** The SQL in *Confirm* step 1 runs today against a live database, and
  it does not need Phase 17 or a metrics backend. Two days is the threshold Phase 19 names.
- **Watch the tier distribution as the leading indicator.** `wispr_tier_total{tier}` is emitted by
  the gateway today (`apps/gateway/src/routes/sessions.ts`). A falling T0 share is the earliest
  signal that memory has fallen behind, and it precedes anybody filing a complaint.
- **Make review a scheduled job with a named owner**, before the first customer generates a
  backlog. Retro-fitting a review habit onto an existing pile is much harder than starting with
  one.
- **Re-index on a cadence for applications that deploy frequently**, so the drift queue carries
  the changes that happened between crawls rather than everything since onboarding. Accept the
  alias cost knowingly, and prefer the review path where the tenant has accumulated vocabulary.
- **Never let the escape hatch become the process.** A full re-index used every week to avoid
  review is the self-healing behaviour of the previous generation of QA tools, arriving through
  operations instead of through code.
