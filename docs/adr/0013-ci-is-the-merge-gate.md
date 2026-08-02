# 0013 — CI is the merge gate, and coverage thresholds are a ratchet

**Status:** Accepted
**Decided:** 2026-08-01 (`d8c5542 ci: the pipeline, the coverage gates, and the parallel-track protocol`)

---

## Context

Phases 0–14 landed on `main` with **no automated gate at all**. Nine pull requests merged before
`.github/workflows/ci.yml` existed. That was survivable because one person ran one session at a
time and read the output of the phase's `Done when` command before merging — the gate was a human
who had just watched the tests run.

[ADR 0012](0012-parallel-tracks.md) removes that property. Several tracks now land in the same
cycle, each rebasing onto the others' work, and no single person watches all of them run. Rule 4
of `CLAUDE.md § "Parallel tracks"` — *nothing merges to `main` without CI green* — is what makes
the rest of that protocol safe, and it needs something to actually be green.

There is a second thing a manual gate cannot do. A `Done when` command proves the phase's own
tests pass. It does not prove that a *later* change did not quietly stop covering them. Coverage
is the instrument for that, and the WisprTest codebase already had an opinion about how to run it,
written in `packages/fingerprint/vitest.config.ts` before any CI existed: coverage is `enabled:
true` in the config rather than behind `--coverage`, because *"a gate that only runs when someone
remembers the flag is not a gate."*

---

## Decision

### The pipeline

`.github/workflows/ci.yml`, on `push` to `main`, `pull_request` against `main`, and
`workflow_dispatch`. Jobs are split **by what they need**, not by package:

| Job | Needs | Gates |
|-----|-------|-------|
| `lint` | a runtime | eslint, prettier, ruff |
| `typecheck` | a runtime | `tsc --noEmit` across the TS packages, `mypy --strict` for the composer |
| `unit` | a runtime | every unit suite, per package, plus the coverage thresholds |
| `integration` | the Compose stack | gateway db/RLS, memory, resolve, sessions; indexer crawl and observers |
| `e2e` | the Compose stack | HUD mount, spoken command, resolver, T2 write-back loop |
| `bench` | the Compose stack | the latency budgets — **report-only**, see [ADR 0014](0014-benchmarks-report-only-in-ci.md) |
| `ci` | — | aggregates the five blocking jobs into one required check |

Three choices inside that carry weight:

**One aggregate required check.** Branch protection on `main` requires exactly one context, `ci`,
with `strict: true` (branches must be up to date before merging). Adding a job above does not
require editing the protection rule. The aggregation is not `needs` alone: `needs` treats a
*skipped* dependency as satisfied, so the job re-reads `toJSON(needs)` through `jq` and fails on
any result that is not `success`. A cancelled or skipped gate fails the merge rather than counting
as a pass.

**The Compose stack, not service containers.** `.github/actions/stack` runs the same
`docker-compose.yml` and the same `make db-up`, `make db-migrate`, `make db-seed` that developers
run. A second definition of the infrastructure is a second thing to keep in step with the first,
and an integration test against a different stack from the one it was written on is an integration
test in name only.

**The workspace packages are built before anything else runs.** `.github/actions/setup` runs
`pnpm --filter "./packages/*" build` because `packages/protocol`, `packages/fingerprint` and
`packages/ui` are each consumed through `./dist/index.d.ts` and `dist/` is gitignored. Without it a
fresh checkout resolves every `import … from 'protocol'` to nothing, every consumer's types
silently degrade to `any`, and the failure surfaces as a wall of `no-unsafe-member-access` lint
errors in files nobody touched. A working tree that has ever run `pnpm build` cannot reproduce it
(`3feb9eb`).

### Coverage as a ratchet

Thresholds are set **just under the measured position**, not at an aspirational round number.
`packages/protocol/vitest.config.ts`:

```ts
thresholds: { statements: 95, branches: 82, functions: 100, lines: 97 }
```

against a measured 96.53% / 84.09% / 100% / 98.77%. The gap is deliberate and small: it is enough
that ordinary churn does not fail the build, and not enough that a new schema can land with no
round-trip test. `packages/fingerprint` sets 90 across the package *and* repeats 90 on
`src/score.ts` and `src/resolve.ts` individually, so the package-level number cannot be met by
piling coverage onto easier modules — `docs/BUILD-PLAN.md` Phase 2 gates those two files
specifically.

A round number would be either a lie or a hurdle. 100% is a lie in a package with an unreachable
defensive branch; 80% on a package already at 96% is a licence to delete tests.

---

## Consequences

### What this buys

- Rule 4 of the parallel-track protocol is enforceable. A track's PR either goes green or does not
  merge, and no reviewer has to have watched it run.
- The gates cover the rules `CLAUDE.md` states but cannot enforce: rule #8 (typed end to end) is
  `typecheck`, rule #9 (tests are part of the deliverable) is `unit` plus `integration` plus `e2e`,
  and the compounding loop from `§ "Resolution tiers"` has its own e2e step
  (`test:writeback-loop`) because if that breaks, what is left is a slower competitor.
- The first run paid for itself twice: it caught a prettier failure on a stray blank line in
  `packages/ui/package.json`, and building it surfaced that `pnpm lint` could not run locally at
  all with worktrees present.

### What it costs

- **"unit tests and coverage gates" names more than it does.** Exactly two packages carry
  thresholds: `packages/protocol` and `packages/fingerprint`. `packages/ui`, `apps/extension`,
  `apps/gateway`, `apps/indexer` and `apps/console` run their suites with **no coverage floor at
  all**, and the composer's step is `pytest -q` with no `--cov`, because `pytest-cov` is not a
  dependency. The job name reads as though coverage is enforced across the workspace. It is
  enforced on the two shared packages and nowhere else.
- **A ratchet that nobody ratchets is a floor that decays into decoration.** Nothing raises the
  thresholds, and nothing reports that actual coverage has moved above them. The mechanism depends
  on a human noticing, which is the same dependency the pipeline exists to remove. This is the
  weakest part of the decision.
- **The prose is already stale.** The comment above the protocol thresholds states the measured
  position as "97.3% statements, 84.1% branches, 100% functions, 99.1% lines". Running the suite
  today reports 96.53 / 84.09 / 100 / 98.77 — which matches `d8c5542`'s commit message and not the
  config comment. The numbers still clear the thresholds, so nothing failed; a comment documenting
  a measurement drifted from the measurement within a day, which is what documenting a measurement
  in a comment gets you.
- **CI never checks that the generated sources are current.** `make build` runs
  `pnpm --filter protocol gen:python` and `make db-codegen`, and the latter fails on a `git diff`
  of the committed Kysely types. **No CI job runs either.** The setup action builds the workspace
  packages, which emits `dist/schema.json` but does not regenerate
  `apps/composer/src/composer/protocol/models.py`. So a Zod schema change that was not accompanied
  by a regeneration passes every gate here, and the guarantee [ADR 0003](0003-contract-first-zod-protocol.md)
  rests on — that Python and TypeScript *cannot* disagree, because one is generated from the other
  — is not asserted anywhere in the pipeline. It is asserted by whoever remembers to run
  `make build`. That is the largest hole in this decision and it should be closed by a job that
  regenerates and diffs, the same way `db-codegen` already does locally.
- **One required check hides which gate failed.** `ci` is a single context, so the protection rule
  reports "ci failed" and the reviewer opens the run to learn why. Acceptable, and the price of not
  having to edit branch protection every time a job is added.
- **The Compose stack is paid for three times.** `integration`, `e2e` and `bench` each bring up
  postgres, redis, qdrant and minio, run migrations and seed, and each installs Chromium. That is
  most of the pipeline's wall-clock time, and it is the direct cost of not maintaining a second,
  lighter definition of the infrastructure.
- **Enabling the gate is ordering-sensitive, permanently.** Branch protection was turned on only
  after the pipeline first went green, because requiring a check that has never passed locks the
  repository out of the fix that would make it pass. The same trap took the repository down for
  real once — see [ADR 0015](0015-codeql-and-the-ruleset-split.md).

### What would reverse it

Nothing reverses having a gate. What should change is its *shape*: coverage enforced on the apps
rather than only the shared packages, a job that verifies the generated contract sources, and a
mechanism that raises the ratchet rather than trusting somebody to. Each of those is an addition,
not a reversal.
