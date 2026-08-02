# 0015 — Code scanning is scoped to `main`; everything else applies to every branch

**Status:** Accepted
**Decided:** 2026-08-02 (`7a7f42b ci: add CodeQL analysis for TypeScript and Python`, plus the
`code-scanning-main` repository ruleset created the same day)

---

## Context

The `core` repository ruleset was created on 2026-07-29 with `ref_name.include: ["~ALL"]` — every
branch in the repository — carrying deletion protection, force-push protection, a `code_quality`
rule at the `errors` threshold, and Copilot code review on push.

A `code_scanning` rule was then added to it, at the same `~ALL` scope, before any code scanning
workflow existed.

That deadlocked the repository. A code-scanning rule holds a push until CodeQL results are
available for the ref. No workflow produced results, so no push completed — including the push
that would have added the workflow. The rule was waiting for an output that could only arrive
through the operation the rule was blocking.

Two details made it total rather than merely annoying. `bypass_actors` is empty and
`current_user_can_bypass` is `never`, so there was no privileged escape. And `~ALL` means every
branch, so there was no unprotected branch to stage the fix on either.

This is a general shape, not a one-off mistake: **a required check that gates the change which
would satisfy it**. `.github/workflows/ci.yml` hit the same shape from the other side and avoided
it — PR #9's reviewer note says branch protection should be enabled *after* the pipeline first goes
green, because "requiring a check that has never passed would lock the repository out of its own
fix." The rulesets were configured in the GitHub UI, where that note did not apply, and the trap
closed.

---

## Decision

Two rulesets, split by **whether the rule needs a workflow result to exist**.

**`core`, scope `~ALL`** — rules that are evaluable with no external input:

| Rule | Effect |
|------|--------|
| `deletion` | branches cannot be deleted |
| `non_fast_forward` | no force-pushes |
| `code_quality` (severity `errors`) | code quality findings at error severity block |
| `copilot_code_review` (`review_on_push: true`, drafts excluded) | automatic review on every push |

**`code-scanning-main`, scope `~DEFAULT_BRANCH`** — the one rule that waits on a result:

| Rule | Parameters |
|------|-----------|
| `code_scanning` | tool CodeQL, `security_alerts_threshold: high_or_higher`, `alerts_threshold: errors` |

Both are `enforcement: active` with no bypass actors.

The workflow that supplies the results is `.github/workflows/codeql.yml`:

- **Two languages, as a matrix.** `javascript-typescript` covers `packages/**` and every
  TypeScript app; `python` covers `apps/composer`. A third language added to the repository is
  silently unanalysed until it is added here — the workflow says so where a reader will see it.
- **No build step.** CodeQL extracts both languages from source, so this workflow shares nothing
  with `.github/actions/setup` and cannot drift from it.
- **The `security-and-quality` query pack**, not the default security-only set, on the workflow's
  stated reasoning that the same repository configuration gates code quality as well as code
  scanning.
- **A weekly schedule** (`32 4 * * 1`) in addition to push and pull request, because alerts depend
  on a query database GitHub updates independently of this repository. A scheduled run finds newly
  classified problems in code nobody has touched.

---

## Consequences

### What this buys

- A branch can always receive its first push. Nothing at `~ALL` scope waits on a workflow result,
  so the deadlock class is structurally gone rather than fixed once.
- Deletion and force-push protection stay universal, which is what protects a track's worktree
  branch under [ADR 0012](0012-parallel-tracks.md) — several branches now exist concurrently and
  none of them should be losable.
- High-severity CodeQL findings still cannot reach `main`. Narrowing the scope narrowed *where*
  the rule applies, not *what* it blocks.

### What it costs

- **Security feedback arrives at the merge, not on the branch.** Because the rule is scoped to the
  default branch, a track working for days on its own branch is never told by the ruleset that it
  has introduced a high-severity finding; it learns at the point of merging. The workflow does run
  on `pull_request`, so the alert is visible in the PR — but visible and blocking are different
  things, and the blocking moment is the latest possible one.
- **Deleting or renaming `codeql.yml` re-creates the deadlock.** The `code_scanning` rule still
  waits for a CodeQL result on `main`. If the workflow file is removed, renamed, or its
  `security-events: write` permission is dropped, pushes to `main` hang again with the same
  symptom and no bypass actor to rescue them. Nothing in the repository prevents that, and the
  coupling is invisible from the workflow's side.
- **The rulesets are not in the repository.** They are GitHub configuration, created through the
  UI, with `gh api repos/:owner/:repo/rulesets` as the only source of truth. Nothing in git records
  what is enforced, nothing reviews a change to it, and there is no history of who changed which
  threshold. This ADR is currently the only written record that `code-scanning-main` exists, which
  is a weak place for a load-bearing configuration to live.
- **`security-and-quality` is a wider, noisier pack than `security`.** It is the right choice given
  what the ruleset gates, and it means more findings, including maintainability findings on a
  codebase deliberately full of long explanatory comments. Expect to triage.
- **Two rulesets is one more thing to reason about.** Somebody adding a future rule has to know
  which of the two it belongs in, and the answer is not obvious from the names — it is the question
  *does this rule wait for something a workflow produces?* That test is the actual decision here
  and it is recorded nowhere in the GitHub UI.
- **CodeQL runs only on `main` and on pull requests targeting it.** A long-lived track branch with
  no open PR is unanalysed, so the weekly scheduled run covers `main` and nothing else in flight.

### What would reverse it

Returning code scanning to `~ALL` becomes safe once CodeQL results exist for every branch and the
workflow is guaranteed present — but it buys little: the results are already visible on every pull
request, and the merge into `main` is the moment that matters. The more valuable change is the
opposite direction: move the ruleset definitions into the repository as configuration-as-code, so
the thing that took the repository down is reviewable in a diff.
