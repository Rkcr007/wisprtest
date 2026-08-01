# 0010 — Python exists only in `apps/composer`

**Status:** Accepted
**Decided:** 2026-07-25 (`2143a40 chore: repository scaffold`)

---

## Context

A polyglot repository is a tax. Two toolchains, two dependency managers, two test runners, two
linting configurations, two ways to be wrong about types, and a class of bug — the contract
between them — that neither language's compiler can see.

It is worth paying only where the second language earns it, and it is worth confining exactly
because the tax scales with surface area rather than with lines of code.

Two things pull in opposite directions here:

- **Constraint solving and distribution sampling are genuinely nicer in Python.** The composer
  fits observed numeric distributions, samples enums by observed frequency, back-dates a field so
  a learned predicate holds, and orders a DAG of records by dependency. Python's numeric and
  property-testing ecosystem (`hypothesis` for "generated records always satisfy their constraint
  set") has no comfortable TypeScript equivalent.
- **Anything that touches DOM semantics must be TypeScript**, because
  [ADR 0002](0002-single-fingerprint-implementation.md) requires one fingerprint implementation
  shared verbatim by the extension and the indexer. A Python component that needed to reason about
  roles, accessible names or geometry would have to reimplement all of it.

---

## Decision

Python lives in `apps/composer` and nowhere else. `CLAUDE.md § "Stack decisions"` states the rule
and its reason: *"Python only in `apps/composer`. Anything touching DOM semantics is TypeScript so
it can share the fingerprint package."*

The boundary is drawn where it is cheapest to cross. The composer is **stateless**: it takes
`(entity_schema, constraints, runtime_state)` and returns a `CompositionPlan`. It has no database
connection, no Redis client, no Playwright, and it never writes to the application under test —
materialization is the gateway's job. The only thing crossing the boundary is JSON validated
against the shared contract, and the pydantic models on the Python side are generated from it
([ADR 0003](0003-contract-first-zod-protocol.md)) rather than written.

Python-side rules match the TypeScript ones rather than being relaxed: `mypy --strict`, full type
hints, no bare `dict`, `ruff` for lint and format, `uv` for dependencies, `structlog` for JSON
logging with `tenant_id` / `session_id` / `trace_id` on every line, and a typed error taxonomy
(`apps/composer/src/composer/errors.py`).

---

## Consequences

### What this buys

- The composer gets Python's numeric and property-testing tools for the one job that wants them,
  without any of them leaking into the resolution path.
- One process boundary, one contract, one generator. The polyglot cost is a fixed, known thing
  rather than something that grows.
- Statelessness makes the boundary cheap in both directions: the composer scales horizontally,
  needs no migrations, and can be restarted or rewritten without touching data.

### What it costs

- **Two toolchains in CI and on every developer's machine.** `pnpm` and `uv`, `vitest` and
  `pytest`, ESLint and ruff, `tsc --noEmit` and `mypy --strict`. `make lint` and `make typecheck`
  hide it; a broken `uv` on a build image does not.
- **`make build` needs `uv` to build TypeScript.** `pnpm --filter protocol gen:python` shells out
  to `uv run datamodel-codegen`, so the Python toolchain is a hard dependency of producing a
  correct *TypeScript* artifact. That is a surprising coupling and it bites in constrained CI
  images.
- **The composer cannot enforce the contract's refinements.** JSON Schema drops Zod refinements,
  so pydantic gets shapes without rules. The composer re-implements what it needs in
  `apps/composer/src/composer/solving/`, which is a small, real duplication that the contract-first
  decision was supposed to eliminate. See [ADR 0003](0003-contract-first-zod-protocol.md).
- **Reviewer availability splits.** A change spanning the gateway and the composer needs someone
  fluent in both. On a small team that is a bus-factor problem, and it slows exactly the changes
  most likely to break the boundary.
- **The boundary invites erosion.** The composer will, sooner or later, want to read
  `entity_schemas` directly instead of being handed one, or to resolve a reference against live
  records itself. Each is locally sensible and each turns a stateless function into a service with
  its own database access, its own tenancy handling, and its own RLS obligations. Statelessness is
  the thing to defend; it is what keeps the Python surface bounded.

### Current gap

The composer does not yet satisfy `CLAUDE.md` rule #6. `apps/composer/src/composer/app.py`
registers **no routes at all** — including `/healthz` and `/readyz` — and does not initialise
OpenTelemetry, though the OTel dependencies are declared in `pyproject.toml`. The module docstring
is explicit that this is a deliberate Phase 14 boundary rather than an oversight ("a placeholder
route handler is exactly what CLAUDE.md rule #1 forbids"), and PR #8 lists health endpoints, OTel
and `POST /v1/compose` as remaining work. The gateway and indexer both have `/healthz` and
`/readyz`; the composer does not, and nothing can currently probe it.

### What would reverse it

If the constraint solver turned out to be simple enough to express in TypeScript — or if the
composer's real bottleneck turned out to be the boundary rather than the solving — folding it into
the gateway would remove a language, a service, a generator and a deploy target. That is a
genuine option and it should be re-evaluated once the solver is complete (Phase 14 part 2) and its
actual complexity is visible, rather than assumed from the design.
