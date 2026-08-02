# 0014 — The performance budgets are measured in CI and enforced by `make bench`

**Status:** Accepted
**Decided:** 2026-08-02 (`c8f37fc fix(ci): make the benchmarks report-only, and fix the flaky HUD collapse test`)

---

## Context

`CLAUDE.md § "Performance budgets"` opens with a sentence that is the whole reason this ADR is
uncomfortable: *"these are tests, not aspirations."* Three of the budgets have benchmark suites
that assert them and fail rather than warn:

| Suite | Asserts | Source |
|-------|---------|--------|
| `bench:scope` | scoped-index recompute p95 < **8 ms** at ≥3000 DOM nodes | `apps/extension/src/runtime/scoped-index.bench.ts` (budget from `docs/BUILD-PLAN.md` Phase 7) |
| `bench:resolve` | T0 p99 < **15 ms** with 500 aliases loaded; T1 p95 < **40 ms** | `apps/extension/test/resolver/resolve.bench.ts` |
| `bench:speech-to-reticle` | speech onset → reticle p95 < **400 ms** | `apps/extension/test/bench/speech-to-reticle.bench.ts` |

`.github/workflows/ci.yml` (`d8c5542`) wired all three into the pipeline as blocking gates, which
is what Phase 19 of `docs/BUILD-PLAN.md` asks for.

The second pipeline run failed on them — and not because of a regression. The same suite that
passes on a developer machine at **3.76 ms and 3.43 ms p95** against the 8 ms scoped-index budget
measured **8.99 ms and 12.98 ms p95** on a shared GitHub runner. The code has better than 2x
headroom; the runner is roughly 3x slower.

That is not a measurement problem to be tuned away, because the budget is not a statement about a
CPU in the abstract. It is a statement about what a tester experiences in their browser — the
scoped-index recompute runs on every mutation batch and is the largest single component of the
400 ms speech-to-reticle budget. A shared 4-core cloud VM is not that machine. Raising the number
until the runner passes would mean the budget no longer describes anything a tester would notice.

And a gate that fails for reasons unrelated to the change is a gate people stop reading. That is
not a hypothetical about discipline; it is the observable behaviour of every team that has had a
flaky required check. The cost lands on the day the gate is right.

---

## Decision

The `bench` job stays in the pipeline, runs on every pull request, and **does not block**. It is
marked `continue-on-error: true` and is deliberately absent from the `ci` aggregate job's `needs`
list, which is the single required check ([ADR 0013](0013-ci-is-the-merge-gate.md)).

The gate that blocks is `make bench`, run on hardware whose performance is known:

```make
## bench: assert the CLAUDE.md latency budgets — the release gate, run on known hardware
bench:
	pnpm --filter extension bench:scope
	pnpm --filter extension bench:resolve
	pnpm --filter extension bench:speech-to-reticle
```

Both halves matter. CI still publishes the numbers on every pull request, because a budget nobody
measures is exactly the aspiration `CLAUDE.md` says it must not become. `make bench` is what turns
a number into a decision, and its target comment says the operating condition out loud: close
anything competing for CPU first, because a benchmark run alongside a video call measures the
video call.

---

## Consequences

### What this buys

- The pipeline's red means something. A failing `ci` check is a real defect, not runner weather,
  which is the property that keeps people reading it.
- The budgets keep describing the tester's machine rather than being redefined upward to fit the
  cheapest available CPU.
- The numbers are still produced on every pull request. A change that doubles a latency is visible
  in the run log even though nothing fails.

### What it costs

This is the part that makes it a trade-off rather than a fix.

- **Nothing stops a performance regression reaching `main` between manual runs.** That is the
  direct, unmitigated consequence. A track can land a change that takes the scoped index from
  3.76 ms to 7.9 ms — still under budget, more than double the cost — and nothing anywhere objects.
  A change that takes it to 9 ms is caught by CI's report only if somebody reads a non-blocking
  job's log on a green PR, which is a thing people do not do.
- **`make bench` is a convention, not a gate.** No release process invokes it, nothing records that
  it was run, and no artifact carries its result. "The release gate" is currently a Makefile target
  and a sentence in a comment. Compare `false execution rate`, which `CLAUDE.md` also calls a
  release gate and which [ADR 0005](0005-reversibility-taxonomy.md) records as unmeasurable — this
  is the second budget in that category, and for a more embarrassing reason, because this one *is*
  measurable and simply is not measured on a schedule.
- **"Hardware whose performance is known" is not defined anywhere.** There is no recorded reference
  machine, no baseline file, and no history of past results. An operator running `make bench` on an
  unfamiliar laptop and seeing 6 ms cannot tell whether that is a regression from 3.76 ms or a
  slower machine. The decision depends on knowledge that lives in one person's head.
- **Report-only hides infrastructure failure too.** `continue-on-error: true` swallows every
  outcome, so a `bench` job that failed because Chromium would not install, or because the Compose
  stack never came up, is indistinguishable at a glance from one that measured 9 ms. The job can
  rot silently and the first sign will be that it has not produced a usable number in months.
- **Three of the six budgets have no benchmark at all.** `CLAUDE.md` lists action dispatch p95
  < 30 ms, indexer throughput > 8 routes/min, and composition preview p95 < 1.2 s. There is no
  suite for any of them — `bench:scope`, `bench:resolve` and `bench:speech-to-reticle` are the
  complete set. So this ADR governs how half the budget table is enforced, and the other half is
  not enforced by anything.
- **The most-often-failing budget is not in `CLAUDE.md`'s table.** The 8 ms scoped-index recompute
  comes from `docs/BUILD-PLAN.md` Phase 7. It is the tightest number and the one the runner blew,
  and a reader checking the budgets in `CLAUDE.md` will not find it.
- **`CLAUDE.md` now describes the pipeline incorrectly.** Rule 4 of `§ "Parallel tracks"` reads:
  *"`.github/workflows/ci.yml` runs lint, typecheck, unit + coverage gates, integration, e2e, and
  the three benchmark gates. The `ci` job is the single required check."* Both sentences are true
  in isolation and misleading together — the workflow does run the three benchmarks, and the `ci`
  job is the required check, but `bench` is not among its `needs`, so the benchmarks gate nothing.
  Corrected here rather than in `CLAUDE.md`, which this track does not own.

### What would reverse it

A self-hosted runner, or any CI machine whose performance is known and stable. That is the whole
condition — the objection is to the hardware, not to gating in CI. On such a runner the `bench` job
loses `continue-on-error`, joins the `ci` job's `needs` list, and this ADR is superseded. Until
then, marking it required would be a false green rather than a gate.

Recording a baseline and diffing against it would soften the largest cost above without needing new
hardware, and should be treated as the interim step rather than as a reason to leave things as they
are.
