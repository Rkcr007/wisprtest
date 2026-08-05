# Architecture Decision Records

`CLAUDE.md` states the rules. This directory states **why**, and — more usefully — **what each
rule cost**. A rule you cannot argue against is a rule nobody can revisit when the constraint
that produced it changes.

Every ADR here answers three questions the prose documentation does not:

1. What was the alternative, and why was it rejected?
2. What does this decision make permanently harder?
3. What would have to become true for it to be worth reversing?

An ADR that lists only benefits is marketing. Each record below names the downside it accepted.

---

## How this log was written

The first eleven records were **reconstructed on 2026-08-02** from `CLAUDE.md`,
`docs/ARCHITECTURE.md`, `docs/TEST-DATA-ENGINE.md`, `docs/BUILD-PLAN.md`, and the state of the
code at commit `81b786c`. The repository did not keep a decision log while phases 0–14 were
built; these records were written after the fact and dated to the commit that first made each
decision real in code.

That means two things:

- The *Context* sections are inferred. Where the reasoning is recorded verbatim in a source file
  or a doc, the record cites it. Where it is inferred, it says so.
- Records 0001–0011 have not been through the review a contemporaneous ADR would have had.
  Anything you find here that disagrees with the code is a bug in this log, not in the code.
  Several such disagreements are recorded — see *Known divergences* below.

Records **0012–0015** are different. They cover decisions taken between `81b786c` and `87ac4d0` —
the parallel-track protocol, the CI pipeline, the benchmark gate and the CodeQL rulesets — and
they were written from the commits, the workflow files and the live repository configuration
rather than reconstructed from prose. Their *Context* sections are not inferred.

New decisions from here on get an ADR **before** the code, not after.

---

## Index

| # | Title | Status | Decided |
|---|-------|--------|---------|
| [0001](0001-in-process-mv3-runtime.md) | The hot path runs in-process in an MV3 extension | Accepted | 2026-07-26 |
| [0002](0002-single-fingerprint-implementation.md) | One fingerprint implementation, shared verbatim | Accepted | 2026-07-25 |
| [0003](0003-contract-first-zod-protocol.md) | Zod in `packages/protocol` is the only contract; pydantic is generated | Accepted | 2026-07-25 |
| [0004](0004-tiered-resolution-and-alias-writeback.md) | Three resolution tiers, and the T2 alias write-back | Accepted | 2026-07-29 |
| [0005](0005-reversibility-taxonomy.md) | Every action carries a reversibility class; class C is never speculative | Accepted | 2026-07-29 |
| [0006](0006-trusted-input-via-cdp.md) | Actions dispatch through CDP, not synthetic DOM events | Accepted | 2026-07-29 |
| [0007](0007-human-approved-drift-only.md) | Drift is proposed by the system and committed by a human. Always | Accepted | 2026-07-25 |
| [0008](0008-multi-tenant-with-row-level-security.md) | Multi-tenant from line one, enforced by Postgres RLS | Accepted | 2026-07-25 |
| [0009](0009-structure-not-content.md) | Product Memory stores structure, never content | Accepted | 2026-07-25 |
| [0010](0010-python-confined-to-composer.md) | Python exists only in `apps/composer` | Accepted | 2026-07-25 |
| [0011](0011-learned-not-configured.md) | Per-application knowledge is learned into tables, never branched on in code | Accepted | 2026-07-25 |
| [0012](0012-parallel-tracks.md) | The unit of work is a track, not a phase | Accepted | 2026-08-01 |
| [0013](0013-ci-is-the-merge-gate.md) | CI is the merge gate, and coverage thresholds are a ratchet | Accepted | 2026-08-01 |
| [0014](0014-benchmarks-report-only-in-ci.md) | The performance budgets are measured in CI and enforced by `make bench` | Accepted | 2026-08-02 |
| [0015](0015-codeql-and-the-ruleset-split.md) | Code scanning is scoped to `main`; everything else applies to every branch | Accepted | 2026-08-02 |
| [0016](0016-writes-go-through-the-indexer.md) | Every write to the app under test goes through the indexer, not the gateway | Accepted | 2026-08-05 |

---

## Known divergences between this log and the code

Recording these here rather than quietly writing the ADRs around them.

- **Screen-scoped aliases cannot be stored.** [ADR 0004](0004-tiered-resolution-and-alias-writeback.md)
  describes screen-scoped aliases shadowing app-wide ones, which is what
  `apps/extension/src/resolver/tier0.ts` implements. The database cannot represent it:
  `aliases_tenant_version_phrase_key` is unique on `(tenant_id, memory_version_id, phrase)` with
  no `state_fingerprint`, and `upsertAliases` overwrites `element_id` on conflict. See the ADR's
  *Consequences* for the detail.
- **The release-gate metric has no producer.** `wispr_false_execution_total` is registered in
  `apps/gateway/src/telemetry/metrics.ts` and exercised by a test, but nothing in the product
  increments it, and `ActionOutcome` has no member that would signal one. See
  [ADR 0005](0005-reversibility-taxonomy.md) and
  [runbooks/README.md](../runbooks/README.md#alerts-that-cannot-fire-yet).
- **The generated contract is never verified in CI.** [ADR 0003](0003-contract-first-zod-protocol.md)
  rests on `apps/composer/src/composer/protocol/models.py` being generated from the Zod schemas, so
  the two *cannot* disagree. `make build` regenerates it and `make db-codegen` fails on a diff of
  the committed Kysely types — and **no job in `.github/workflows/ci.yml` runs either**. A schema
  change that was not regenerated passes every gate. See
  [ADR 0013](0013-ci-is-the-merge-gate.md).
- **The blocking performance gate is a Makefile target nobody is required to run.**
  `CLAUDE.md § "Performance budgets"` calls these tests rather than aspirations, and CI measures
  them without blocking. Between manual `make bench` runs, nothing stops a regression reaching
  `main`. See [ADR 0014](0014-benchmarks-report-only-in-ci.md).
- **The API materializer cannot run against a token-authenticated application.** A bearer token
  lives in the application's own JavaScript and is never captured, so the replay in
  [ADR 0016](0016-writes-go-through-the-indexer.md) has no way to present it. The chain refuses
  with a reason and falls through to the UI adapter, which is correct and also means the fast path
  is unavailable for a large share of real applications.
- **A failed materializer is demoted but no re-observation is queued.** `BUILD-PLAN.md` Phase 16
  asks for both. The demotion is real — `verified_at` is cleared and the ordering rule reads it —
  but nothing schedules the re-crawl that would restore it, because crawl bounds are supplied per
  request and are not stored per application, and `drift_reports` requires a screen and structural
  hashes that an API failure does not have. Recovery is a human starting a crawl. See
  [ADR 0016](0016-writes-go-through-the-indexer.md).
- **`docs/BUILD-PLAN.md` describes a scheduling model that has been replaced.** Its *How to run a
  session* section is the Phases 0–14 protocol; `CLAUDE.md § "Parallel tracks"` is current. The
  file has been annotated rather than rewritten — the phase prompts below that section are
  unchanged and still authoritative. See [ADR 0012](0012-parallel-tracks.md).

---

## Format

Title, Status, Context, Decision, Consequences. Consequences are split into what the decision
buys, what it costs, and what would reverse it. Status is one of `Proposed`, `Accepted`,
`Superseded by NNNN`, `Deprecated`. Records are immutable once accepted — a changed mind is a new
record that supersedes the old one, so the reasoning that was current at the time survives.
