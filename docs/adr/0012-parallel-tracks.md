# 0012 — The unit of work is a track, not a phase

**Status:** Accepted
**Decided:** 2026-08-01 (`d8c5542 ci: the pipeline, the coverage gates, and the parallel-track protocol`)

---

## Context

Phases 0–14 were built one per session, sequentially. `docs/BUILD-PLAN.md` states the rule at the
top of the file — *"One phase per Claude Code session"* — and gives the reason: *"Long sessions
accumulate context that makes the model conservative and repetitive."*

Both halves of that reasoning still hold, and they are worth separating because only one of them
is about context windows:

- **A session that spans several phases degrades.** It accumulates enough of its own prior output
  that it starts optimising for consistency with what it already wrote rather than for the task.
  The observable symptom is repetition and unwillingness to change earlier decisions.
- **A wide blast radius makes a bad result expensive.** The recovery move in `BUILD-PLAN.md` is
  `git reset --hard` and re-run the prompt with one added constraint. That is only cheap when the
  thing being discarded is one phase.

What the rule cost was throughput, and it cost it unconditionally — including for work that had no
reason to be serialised. The dependency lines in `BUILD-PLAN.md` make this concrete past Phase 14:
Phase 15 depends on 12 and 14; Phase 17 depends on 5 and 8. Neither depends on the other. Phase 19
touches `infra/`, and this documentation track touches `docs/`, and neither touches application
code at all. Running those one after another buys nothing.

The risk of running them concurrently is not conceptual, it is mechanical. Two sessions editing
the same directory, or the same `packages/protocol` schema, or the same database, produce failures
that look like bugs rather than like collisions — which is the worst kind, because they get
debugged instead of avoided.

---

## Decision

The unit of work is a **track**: one owner, one module, one branch, one PR.
`CLAUDE.md § "Parallel tracks"` is the protocol. Six rules make it safe, and each maps to a
specific collision:

| Rule | The collision it prevents |
|------|---------------------------|
| One owner per module; a track writes only to the directory named in its brief | Two sessions editing the same file, including shared config — adding a dependency to another module's `package.json` or `pyproject.toml` is that owner's change |
| `packages/protocol` is never edited by a track | Rule #3 makes the contract the thing every module is checked against, so a concurrent edit there breaks every track at once. Contract changes serialize through the lead and every track rebases |
| Each track works in its own git worktree | Branches stomping one another's working directory |
| Nothing merges to `main` without CI green | A track landing something the next track builds on top of and inherits — see [ADR 0013](0013-ci-is-the-merge-gate.md) |
| A blocked track stays blocked | Building against an imagined interface and rewriting it later, which is how two sides drift |
| Only one track runs Compose-backed suites at a time | Every worktree on the machine talks to the same postgres, redis, qdrant and minio. `make db-reset` in one drops the database another is mid-assertion against |

The last one is a **local** constraint only. In CI each job gets its own runner and its own stack
(`.github/actions/stack`), which is why `integration`, `e2e` and `bench` run in parallel there and
not here.

What has not changed: every rule in `CLAUDE.md § "Non-negotiable engineering rules"` applies to
every track. No stubs, tests are part of the deliverable, and a track reports the real output of
its `Done when` command rather than rounding up.

---

## Consequences

### What this buys

- Independent work runs independently. Phases 15 and 17 have no dependency on each other and no
  longer wait for each other.
- The blast radius got *smaller*, not larger. A track owns one directory, so a bad result is
  discarded by dropping one branch — narrower than the phase model, where a session could touch
  the gateway, the extension and the protocol in one go.
- Module ownership makes review tractable. A reviewer of a track's PR knows the diff is confined
  to one module and that the contract underneath it did not move during the work.

### What it costs

- **A track that needs a contract change stops.** That is the intent of rule 5, and it is a real
  stall: the work is blocked on a serialized `packages/protocol` change landing and every other
  track rebasing onto it. The alternative — writing against an imagined schema — is slower, but
  the cost here is paid in wall-clock waiting by whoever is blocked, not by whoever benefits.
- **Ownership boundaries produce work that has no owner.** A track that needs a one-line change in
  another module's config has to ask, and the smaller the change the more likely it is that
  nobody does. Shared root-level files (`package.json`, `.prettierignore`, `Makefile`, the CI
  workflow) are the recurring friction point, because every track has an opinion about them and
  none of them owns them.
- **Every track starts cold.** The context that a long session accumulated for free — which is the
  thing the phase rule was trying to *limit* — now has to be re-derived by each track from
  `CLAUDE.md` and `docs/`. That is a per-track fixed cost, and it is the direct price of the
  degradation the phase rule was avoiding. It is also why the documentation being accurate matters
  more under this model than it did under the old one.
- **The shared Compose stack serialises exactly the tracks that most need to run.** A track owning
  `apps/gateway` or `apps/indexer` is integration-heavy by nature; a docs track needs nothing. So
  the constraint bites hardest on the tracks doing the real work, and "run unit suites instead" is
  not a substitute for the suite that would have caught the bug.
- **`main` moves under every track.** Under the phase model there was one branch at a time and
  rebasing was trivial. Now a track that runs long rebases repeatedly, and the last track to merge
  in a cycle absorbs the conflicts from all the others.
- **Worktrees inside the repository broke tooling once already.** They live under `.claude/`, which
  is inside the checkout, so eslint's type-checked rules loaded every worktree's TypeScript program
  at once and V8 aborted on heap exhaustion — `pnpm lint` could not run at all locally. Fixed by
  ignoring `.claude/` in eslint, Prettier and git (`d8c5542`). CI never saw it, because CI checks
  out fresh. Expect more of this shape: tooling that assumes one checkout per repository.

### The documentation this contradicts

`docs/BUILD-PLAN.md` still opens with *"Exact prompts, in order. One phase per Claude Code
session"* and repeats it under *How to run a session*. As of this ADR that is the description of
how Phases 0–14 were built, not of how work is done now, and the file has been amended to say so
rather than left to contradict `CLAUDE.md`. The phase *prompts* are unchanged and remain the
specification for what each phase must deliver — it is only the scheduling rule around them that
this ADR replaces.

### What would reverse it

Evidence that the tracks are colliding despite the rules — repeated merge conflicts in owned
directories, or a defect traced to two tracks assuming different versions of the contract. The
model depends entirely on CI being trustworthy and on module ownership being real; if either
erodes, serialising again is the correct retreat and it is cheap to make, because a track is
already a strictly smaller unit than a phase.
