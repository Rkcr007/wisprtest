# 0007 — Drift is proposed by the system and committed by a human. Always

**Status:** Accepted
**Decided:** 2026-07-25 (`d60052e feat(db): PostgreSQL schema, row-level security and the seed fixture`
encodes it in constraints; stated in `docs/BUILD-PLAN.md` Phase 17 from `b6a6a9e`)

---

## Context

Applications change. A button gets relabelled, a form gains a field, a table becomes a card list.
Product Memory, built by a crawl weeks ago, is now partly wrong. The extension detects this
cheaply: `structuralHash` computed on route settle no longer matches the value stored for that
screen.

The question is what happens next, and there is a well-trodden wrong answer.

The previous generation of automated QA tools — the self-healing test frameworks — answered it
with automatic repair. A locator stops matching, the tool finds the most similar element, rebinds
to it, and the test goes green. The pitch was maintenance-free tests. What was actually delivered
was a test suite that could not fail for the reason it was written.

The failure is specific and it is worth naming precisely, because "we do not auto-heal" sounds
like conservatism until you see it:

- A team renames "Submit order" to "Place order". Self-healing rebinds. Correct, and nobody had
  to do anything.
- A team *removes* "Submit order" and adds "Save draft" nearby. Self-healing rebinds to the
  most similar remaining element. The test now clicks Save draft, asserts a success toast,
  and passes. The regression it existed to catch — that you can no longer submit an order —
  ships.

The tool cannot tell those apart, because the difference is intent and the tool has none. And the
second case is not rare; it is what a refactor looks like.

The damage compounds. Once a team has been burned by a green suite that should have been red,
they stop trusting green. A test suite nobody trusts is worse than no test suite, because it
still costs money to run and maintain.

WisprTest is a *manual* QA tool, which changes the shape but not the substance. There is no
overnight suite to go quietly green. But there is a tester in front of a screen, and a memory
version that silently rebound "approve" to a different button will produce a confident wrong
click — the exact failure [ADR 0005](0005-reversibility-taxonomy.md) exists to prevent, arriving
through the back door of memory maintenance rather than the front door of speculation.

---

## Decision

The system proposes. A human commits. There is no auto-approve path, and none is to be added,
even behind a feature flag.

`docs/BUILD-PLAN.md` Phase 17 states it as a build instruction; the database enforces it as a
constraint. In `db/migrations/20260725120000_core_schema.sql`:

```sql
CONSTRAINT drift_reports_decision_needs_approver
    CHECK (status NOT IN ('approved', 'rejected')
           OR (approved_by IS NOT NULL AND resolved_at IS NOT NULL))
```

A drift report cannot reach a terminal decision without a `users` row on it and a timestamp.
`memory_versions.approved_by` carries the same idea for activation. The comment on the column
says it in the schema, where it will be read: *"Human approval is required before a memory version
becomes active. Automatic self-healing is what destroyed trust in the previous generation of QA
tools; there is no auto-approve path and none is to be added, even behind a flag."*

The system does everything up to the decision:

1. The extension detects the hash mismatch on route settle, emits a `DriftReport`, shows a
   **non-blocking** notice, and keeps working in degraded mode. A tester is never blocked by a
   stale memory.
2. The indexer re-crawls **only the changed region** and produces a `StructuralDiff` — added,
   removed, moved, renamed — plus any schema changes from re-running the Phase 13 observers there.
3. It attempts alias migration where fingerprints still match above threshold and reports the
   rate (`drift_reports.alias_migration_rate`).
4. A human reviews the diff in the console and approves or rejects.
5. Approval applies the diff, increments `memory_version`, migrates aliases, invalidates the
   snapshot cache, and flags affected saved flows.

The flag ban is the operative part. A flag is how this decision dies: it ships off by default,
one impatient customer turns it on, it becomes the recommended configuration for large
applications, and two years later it is the default. The correct place to absorb approval fatigue
is better diffs and bulk approval of *reviewed* changes, never an unreviewed path.

---

## Consequences

### What this buys

- A memory version that is active was looked at by somebody. That is the entire trust argument
  for the product, and it is not recoverable once given up.
- The audit trail is real. `drift_reports.approved_by`, `memory_versions.approved_by` and
  `audit_log` answer "who decided this application now means that" — which is a question
  regulated customers ask.
- Drift review is a place a QA lead adds judgement the system does not have. A renamed button and
  a removed feature look identical to a differ and completely different to the person who reads
  the release notes.

### What it costs

- **A queue that only humans can drain.** Drift reports accumulate at the rate the customer
  deploys. A team shipping daily generates drift daily. If nobody reviews for a week, memory is a
  week stale and the tester works in degraded mode the whole time. This is the single largest
  operational risk the decision creates, and it has its own runbook —
  [runbooks/drift-backlog.md](../runbooks/drift-backlog.md).
- **Approval fatigue produces rubber-stamping.** A reviewer facing forty diffs will approve all
  forty without reading them, which delivers the harm of auto-approval while keeping its costs.
  Mitigating this is a product problem — diff quality, grouping, confidence-ordered review — and
  it is not solved by the decision, only forced into the open.
- **A competitor will demo faster.** "Our tests heal themselves" is a better slide than "a human
  reviews the diff." Sales will feel this. The counter-argument has to be told as the story
  above, not as a principle.
- **Degraded mode has to actually work.** Because memory can be stale for days, the runtime path
  cannot assume it is correct. Two layers do this, and both exist only because of this ADR. At the
  element level, T0 discounts aliases whose bound element no longer matches its fingerprint
  (`apps/extension/src/resolver/tier0.ts`), pushing toward disambiguation instead of a wrong hit. At
  the screen level, `apps/extension/src/speculation/classify.ts` forces class `A` on any screen
  whose structural hash no longer matches memory — nothing runs from a partial hypothesis and every
  action needs an explicit yes.

### As built

Phase 17 shipped across six PRs, and the decision held: there is no auto-approve path, not even
behind a flag. `apps/gateway/src/routes/drift.ts` gates approval on the `drift:approve` permission;
the indexer's reconcile worker leaves its candidate version `building` and never activates one; and
approving flips a status rather than editing memory in place, so a session mid-flight keeps
resolving against the version it loaded.

One constraint was narrowed on the way, and it is worth recording here because it looks like a
weakening and is not. `drift_reports_decision_needs_approver` originally required `approved_by` on
any decided report, which contradicted the `ON DELETE SET NULL` on that same column: deleting a user
who had once approved a report failed on a table nobody was touching. The CHECK now requires
`resolved_at` instead (`20260806120000_drift_decision_survives_user_deletion.sql`). The property
this ADR cares about — that a human is on the record — moved to `audit_log`, which
`docs/ARCHITECTURE.md § 8` already makes the durable record and which nothing nulls. What remains
impossible is a decided report with no decision timestamp, and a status reaching `approved` without
a human making the call.

### What would reverse it

Nothing. If this is ever reversed, it will be reversed by pressure rather than by argument, which
is exactly why the reasoning is written down here at length. A future engineer who wants an
auto-approve path should have to read this and explain what has changed about the second case
above.
