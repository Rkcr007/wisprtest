# 0005 — Every action carries a reversibility class; class C is never speculative

**Status:** Accepted
**Decided:** 2026-07-29 (`ce5c299 feat(runtime): speculation controller, CDP executor, and intent parser`).
The taxonomy itself is in `CLAUDE.md` from `b6a6a9e`.

---

## Context

Speculative execution is what makes the product feel instant. ASR emits partial hypotheses long
before it emits a final transcript; acting on a partial buys hundreds of milliseconds. The
p95 speech-onset-to-reticle budget of 400 ms assumes it.

Speculating on a partial hypothesis means acting on a guess that may be revised. For "scroll
down" that is fine — the revision rolls back and nobody notices. For "approve" it is a wire
transfer.

The asymmetry is the whole point:

- A latency regression costs satisfaction. Testers grumble and keep using the product.
- A false execution costs the account. A tester who watches WisprTest approve the wrong order
  once will not use it again, and neither will their team.

`CLAUDE.md § "Performance budgets"` makes `false execution rate < 0.1%` a release gate, and
`§ "Reversibility taxonomy"` says it directly: "a confident wrong click costs more trust than any
latency win gains."

So there has to be a rule about *which* actions may be speculated on, and it has to be
mechanical. "Be careful with destructive actions" is not a rule, it is a hope. It also has to
survive a codebase where several people and several agents write dispatch code over months.

---

## Decision

Every action is classified before it can be dispatched.

| Class | Meaning | Speculative execution | Confirmation |
|-------|---------|----------------------|--------------|
| **R** — Reversible | focus, hover, scroll, expand, read-only navigation | Yes, on a partial hypothesis | No |
| **C** — Committing | submit, delete, approve, any state mutation | **Never** | Yes — finalized transcript + explicit yes |
| **A** — Ambiguous | resolver confidence below threshold | Pre-stage only (focus + reticle) | Yes |
| **S** — Seeding | test data creation | **Never** | Yes — preview shown before write |

The rule is enforced in three independent places, on purpose. Any one of them could be bypassed
by a mistake; all three is much harder.

**1. Structurally, in the contract.** `ActionRequest` in `packages/protocol/src/runtime.ts`
carries three refinements: a speculative request must be class `R`; a class `C` request must be
`confirmed`; a class `S` request must be `confirmed`. An unsafe request does not fail a check —
it cannot be constructed.

**2. In the classifier.** `apps/extension/src/speculation/classify.ts` maps verb → class, with a
confidence gate applied *first*: below `threshold` (0.72) the action is `A` regardless of verb, so
a low-confidence "approve" is staged and surfaced for disambiguation rather than silently
confirmed.

**3. In the controller.** `apps/extension/src/speculation/controller.ts` stages rather than
executes for anything that is not class `R` above threshold, and a class `C` action additionally
requires a finalized transcript **plus** a 150 ms stability window **plus** an explicit
confirmation.

### `click` is class C

The most consequential detail, and the one most likely to be argued with. `classify.ts` maps
every `click` to `C`. On a live application WisprTest did not write, the effect of a click cannot
be proven reversible — a button labelled "Save" and a button labelled "Expand" are the same DOM
primitive.

This does not make navigation slow. The intent parser routes "open orders" and "go to settings"
to the `navigate` verb, grounded in the snapshot's nav-edge vocabulary, and `navigate` is `R`.
Only a genuine button press that names no navigation target falls through to `click`.

Finer per-element reversibility — *this* button only toggles an accordion, so it is really `R` —
is real knowledge, but it is knowledge about one application. Per
[ADR 0011](0011-learned-not-configured.md) it belongs in the memory record, tagged during
indexing, never as an `if (name === 'expand')` in the classifier. Until memory carries it, the
conservative table stands.

`docs/BUILD-PLAN.md` Phase 10 makes the test a release gate: *a class C action is NEVER executed
from a partial hypothesis, including the case where the partial and final transcripts are
identical.*

---

## Consequences

### What this buys

- The worst bug in the product is prevented by a type, not by discipline.
- The taxonomy gives the HUD a vocabulary. A staged class `C` action renders a reticle and waits;
  the tester sees exactly what would happen before it happens. That visibility is worth as much
  as the safety.
- Rollback only has to work for class `R`. `apps/extension/src/speculation/rollback.ts` handles
  focus, scroll, field value and filter state — a small, closed set. If speculation were allowed
  anywhere else, rollback would have to be general, and general rollback of a customer's
  application is impossible.

### What it costs

- **Every click is slower than it could be.** A tester saying "click expand" waits for a final
  transcript, a 150 ms stability window and a confirmation, for an action that was harmless. This
  is the largest, most visible tax the decision imposes, and it will generate feature requests.
  The correct answer to those requests is per-element reversibility learned at index time — not
  an exception in the classifier.
- **Confirmation is a UX cost, repeatedly.** A flow with six committing actions costs six
  explicit yeses. There is real pressure here toward "trusted flows" auto-confirmation.
  `docs/TEST-DATA-ENGINE.md § 6` allows for it as a *future preference* on seeding and is explicit
  that the default is, and stays, approval.
- **The refinements are TypeScript-only.** JSON Schema cannot express a cross-field refinement in
  a form the pydantic generator honours, so the three `ActionRequest` rules do not survive into
  `apps/composer/src/composer/protocol/models.py`. Today this is safe — the extension is the only
  component that dispatches actions and the composer never constructs an `ActionRequest` — but it
  is a guarantee that exists in one language only, and the contract file says so. Any future
  Python producer of this type has to re-assert all three by hand.
- **Classification is per-verb, so it is coarse.** Nine verbs, one class each. That is a blunt
  instrument on an application where most of the interesting controls are `<button>`.

### The gap: the release gate cannot be measured

`CLAUDE.md` gates every release on `false execution rate < 0.1%` and
`docs/ARCHITECTURE.md § 7` says `wispr_false_execution_total` "alerts at any nonzero rate."

The counter is registered in `apps/gateway/src/telemetry/metrics.ts` and covered by a test that
records a value and reads it back. **Nothing in the product increments it.**
`apps/gateway/src/routes/sessions.ts` increments `tierTotal` on step ingest and nothing else, and
`ActionOutcome` (`packages/protocol/src/runtime.ts`) has five members — `executed`, `staged`,
`rolled_back`, `rejected`, `failed` — none of which means "this executed against the wrong
element."

That is not an oversight in the metric; it is an unsolved product question. A false execution is
only knowable after the fact, by a human noticing. Until there is a way for a tester to say "that
was wrong" and have it recorded against the step, the gate is enforced by the Phase 10 test — a
class `C` action is never executed speculatively — and not by a measurement.

The gate should not be described as measured until that path exists. See
[runbooks/README.md](../runbooks/README.md#alerts-that-cannot-fire-yet).

### What would reverse it

Nothing reverses the taxonomy. What *changes* is the granularity: once `elements` carries a
learned reversibility signal, `classify.ts` consults it and a proven-reversible click becomes `R`.
That is a refinement of this ADR, not a replacement — the classes, the structural enforcement and
the ban on speculating outside `R` all survive it.
