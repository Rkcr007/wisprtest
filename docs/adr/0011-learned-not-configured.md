# 0011 — Per-application knowledge is learned into tables, never branched on in code

**Status:** Accepted
**Decided:** 2026-07-25 (`b6a6a9e docs: architecture, test-data engine, build plan`; first enforced in `e2c1259`)

---

## Context

Every enterprise QA tool starts general and ends up as a consulting business. The mechanism is
always the same, and it is always locally reasonable:

A customer's application has a quirk. The generic code does not handle it. Somebody adds
`if (app === 'northstar')` with a comment explaining why, and it ships that afternoon. It works.
The customer is happy. Six months later there are forty of those branches, the product cannot be
onboarded without an engineer, and the sales motion has quietly become "we'll build it for you."

The distinction that prevents it is not "write generic code" — everyone intends that. It is being
explicit, per component, about which side of the line it falls on, and having a place for the
per-application knowledge to *go* so that the branch is never the path of least resistance.

`CLAUDE.md § "What is generic vs what is per-application"` draws the line, and
`docs/TEST-DATA-ENGINE.md § 1` calls it "the line that governs everything."

---

## Decision

**Generic — written once, ships to every customer:** crawler, fingerprinting, resolver, runtime
state engine, voice pipeline, executor, HUD, schema *inference* engine, constraint solver,
composition engine, adapter *interfaces*, ledger, drift detection.

**Per-application — learned at index time or configured in the console, stored in tables, loaded
at runtime:** element fingerprints, navigation graph, entity schemas, field types and
requiredness, enum vocabularies, value distributions, referential graph, derived-field rules,
predicate definitions, materializers, auth profiles, environment policy, alias corpus.

The tables are the enforcement. If `if (app === '…')` is the only way to express something, the
schema is missing a column — that is the signal, and the fix is the column.

Three places this shows up as a real design constraint rather than a slogan:

- **The indexer's config carries nothing about what to crawl.**
  `apps/indexer/src/config.ts` holds Redis, Postgres, the worker id and the browser mode. Origins,
  depth cap, page cap, the never-interact selector list and the auth profile all arrive **on the
  job**, because they are per-application knowledge and because "the record of what a crawl was
  permitted to do should be the same record that was executed."
- **The classifier's verb table is overridable data.**
  `apps/extension/src/speculation/classify.ts` maps every `click` to class `C`. The obvious
  optimisation — this particular button only toggles an accordion, so it is really `R` — is
  correct and is *deliberately not implemented*, because it is knowledge about one application.
  The module says so in as many words: it "belongs in the memory record, tagged during indexing —
  never as an `if (name === 'expand')` here." The conservative table stands until memory can carry
  the answer.
- **The composer's lexicon holds English, not domain language.**
  `apps/composer/src/composer/parsing/lexicon.py` holds counting words and comparison phrasings.
  Field names, enum vocabularies and predicate names all come from the learned schema. A parser
  that knew what an "order" was would be a parser that only worked for one customer.

`docs/BUILD-PLAN.md` ships a recovery prompt for when this is violated, which is the correct
admission that it *will* be violated under pressure.

---

## Consequences

### What this buys

- Onboarding a new customer is a crawl, not an engagement. That is the difference between a
  product and a consulting business, and it is the single most important structural property of
  the codebase.
- Fixing something for one customer fixes it for all of them, because the fix is in generic code
  or in the way knowledge is learned.
- Per-application knowledge is versioned, auditable and revertible, because it lives in
  `memory_versions` and its children rather than in a deploy.

### What it costs

- **Everything takes longer to build.** A learned enum vocabulary with confidence, a distinct-ratio
  guard and a length bound (`apps/indexer/src/observers/pii.ts`) is a great deal more work than
  hardcoding four statuses for the customer in front of you. That cost is paid up front, on every
  feature, for a benefit that only materialises at the third or fourth customer.
- **Learned knowledge is uncertain, and uncertainty must be handled everywhere.** Every learned
  artifact carries a confidence: `elements.confidence`, `entity_schemas.confidence`,
  `field_specs`, `nav_edges.confidence`. Every consumer has to decide what to do when it is low —
  hence `schema_confidence_too_low` (422) in the gateway's error taxonomy and the
  `resolutionThreshold` in the resolver. A hardcoded value has no confidence and no branch.
- **Some things genuinely cannot be learned yet, and the honest answer is a gap.** Predicates
  ("overdue" ⇒ `due_date < now() AND status ≠ Paid`) are inferable only where a UI surfaces a
  named status derived from field values. `docs/TEST-DATA-ENGINE.md § 3` accepts a console
  surface where a QA lead defines them by hand. That is per-application *configuration* rather
  than per-application *code*, which is the right side of the line, but it is a manual step in a
  product whose pitch is that there are none.
- **The pressure is constant and it comes from the customer.** "Can you just make it work for our
  app" is a reasonable request that a salesperson will pass on and an engineer can satisfy in an
  hour. Nothing in the architecture prevents it — only the rule, the recovery prompt, and whoever
  is reviewing.
- **Debugging is indirect.** When resolution fails for one customer, the cause is data in
  `elements` and `aliases` for one `memory_version`, not a line of code anyone can read. The
  console's memory explorer (Phase 18) is not a nice-to-have; it is the debugger for this
  decision, and it is unbuilt.

### What would reverse it

Nothing reverses the rule. What can legitimately move is the *line*: knowledge that is currently
hardcoded because it cannot yet be learned — per-element reversibility, predicate definitions —
should migrate to the learned side as the observers get better. Movement in the other direction,
from learned to hardcoded, is always a defect.
