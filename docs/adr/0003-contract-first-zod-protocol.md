# 0003 — Zod in `packages/protocol` is the only contract; pydantic is generated

**Status:** Accepted
**Decided:** 2026-07-25 (`afd8dd9 feat(protocol): schemas, JSON Schema bundle and pydantic generation`)

---

## Context

Six deployables exchange payloads: the extension, the gateway, the indexer, the composer, the
console, and the database (via generated Kysely types). Five are TypeScript. One is Python.

Every one of them has an opinion about what a `CompositionPlan` is. Left alone, each would grow
its own: a TS interface here, a pydantic model there, a JSON shape in a test fixture, an
assumption in a SQL column. They agree on the day they are written and diverge on every day
after. The failure mode is not a type error — it is a field the composer stopped sending and the
gateway never noticed was missing, discovered when a preview card renders blank in front of a
customer.

Validation matters as much as typing. A TypeScript interface is erased at runtime; it tells you
nothing about a JSON body that arrived over HTTP or a job payload pulled off a Redis stream. Both
of those are trust boundaries: `apps/indexer/src/redis/job-stream.ts` notes that an unvalidated
job "is how an unbounded crawl or an unallowlisted target would get in."

The Python side is the sharp edge. A hand-written pydantic model that mirrors a Zod schema is the
single most reliable place in this repository for drift to hide, because nothing type-checks
across the language boundary and the two files are edited by different people at different times.

---

## Decision

`packages/protocol` holds Zod schemas for every payload that crosses a process boundary.
TypeScript types are derived with `z.infer` and never hand-written. Nothing outside this package
defines these shapes.

Python does not get a second definition. The pipeline is:

```
packages/protocol/src/**  (Zod, the source of truth)
      │  pnpm --filter protocol build
      ▼
packages/protocol/dist/schema.json          (JSON Schema bundle, $defs container)
      │  pnpm --filter protocol gen:python   → datamodel-code-generator
      ▼
apps/composer/src/composer/protocol/models.py   (pydantic v2, committed)
```

Three details that carry weight:

- **The generated Python is committed**, not built on the fly. It is source the composer imports
  and `mypy --strict` checks, and reviewing a contract change means seeing both sides of it in
  the same diff.
- **`gen:python` is wired into `make build`**, alongside `db-codegen` for the Kysely types, so a
  build type-checks against the current contract rather than the last generated copy of it.
- **The generator's artificial document-root model is removed with an exact string match**
  (`ROOT_MODEL_STUB` in `packages/protocol/scripts/gen-python.ts`). If a generator upgrade
  changes that stub, the script fails rather than leaving something unexplained at the top of the
  contract.

Every schema gets a round-trip test with at least one valid and one invalid fixture
(`packages/protocol/src/fixtures.ts`, `contract.test.ts`), and the fixtures are exported to
`apps/composer/tests/protocol_fixtures.json` so Python asserts against the same cases.

Schemas also carry the invariants, not just the shapes. `ActionRequest` in
`packages/protocol/src/runtime.ts` uses refinements to make a speculative non-`R` request and an
unconfirmed `C`/`S` request structurally unconstructible — see
[ADR 0005](0005-reversibility-taxonomy.md).

---

## Consequences

### What this buys

- Python and TypeScript cannot disagree about a shape. Not "should not" — cannot, because one of
  them is generated from the other.
- Every trust boundary validates. `safeParse` at the edge of every route, every stream consumer,
  and every model response (`apps/gateway/src/model/prompt.ts` rejects an `elementId` the model
  invented) turns a class of runtime surprise into a typed 400.
- The contract is a readable artifact. `packages/protocol/src/*.ts` is where a new engineer
  learns the system, and the doc comments there are the closest thing to a specification.
- A contract change is a visible change. Regenerating produces a diff in
  `apps/composer/src/composer/protocol/models.py`; a reviewer sees the blast radius.

### What it costs

- **Everything routes through one package.** A field added to `SessionStep` touches
  `packages/protocol`, its fixtures, its tests, the generated Python, and then the consumers.
  That is friction on every change, including trivial ones, and it is felt most by whoever is
  trying to ship something small.
- **The generated Python is not idiomatic and is not editable.** Field names are snake_case with
  the wire name as an alias and `populate_by_name` set. A Python engineer who wants a validator,
  a computed property, or a nicer constructor cannot add one to the generated file — it has to be
  a wrapper. The composer accepts a less pleasant Python API in exchange for the guarantee.
- **`make build` depends on tooling most CI images do not have.** `gen:python` shells out to `uv
  run datamodel-codegen`, and `db-codegen` needs a running, migrated Postgres. A build machine
  that has neither cannot produce a correct artifact — it can only produce a stale one, which is
  why the Makefile fails on a `git diff` of the generated Kysely files rather than regenerating
  silently.
- **JSON Schema is a lossy waypoint.** Zod refinements — the `ActionRequest` invariants above,
  cross-field checks, `.superRefine` — do not survive the export. The Python models get the
  shapes and not the rules. The composer therefore cannot rely on pydantic to enforce anything
  a refinement expressed, and re-implements what it needs (`apps/composer/src/composer/solving/`).
  This is the sharpest edge of the decision and is easy to forget.
- **One contract for the whole system means one blast radius.** There is no per-service
  versioning; a breaking change to a schema breaks every consumer at once. Acceptable while
  everything deploys together. It will not stay acceptable once the extension ships through the
  Chrome Web Store on a different cadence than the gateway.

### What would reverse it

Independent release cadences. The moment a shipped extension version has to talk to a gateway
that has moved on, this needs versioned schemas and an explicit compatibility policy, not a
single mutable contract. Plan for that before the first forced-install rollout, not after.
