# 0002 — One fingerprint implementation, shared verbatim

**Status:** Accepted
**Decided:** 2026-07-25 (`5732886 feat(fingerprint): element fingerprinting and the scoring resolver`)

---

## Context

Two processes have to agree on what an element *is*.

The indexer walks a customer application in Playwright and writes an `ElementFingerprint` for
every interactive control. Weeks later, the extension looks at a live DOM and asks "which of
these nodes is the one the indexer called `orders.filter.pending`?" If the two compute
fingerprints even slightly differently — a different accessible-name fallback order, a different
notion of which attributes are stable, a different landmark ancestry walk — the score drops below
threshold and resolution fails. It does not fail loudly. It fails as a tester saying "it used to
find this button" while every test passes.

This is the classic two-implementations-of-one-spec problem, and it is worse here than usual for
three reasons:

1. The spec is not simple. `docs/ARCHITECTURE.md § 2` lists seven weighted signals, one of which
   is a subset of the ARIA accessible-name computation.
2. The two runtimes look different. One is a browser content script; the other is a Node process
   with a browser at the end of a Playwright connection.
3. The failure is silent and slow. Drift between the implementations manifests as a gradual
   decline in T0 hit rate, which looks exactly like an application that changed.

The tempting shape — and the one rejected — is for the indexer to extract a DOM description into
Node (roles, names, geometry as JSON) and fingerprint it there. That reads as clean separation.
It is not: computed ARIA role, accessible name, and layout geometry are *browser* computations,
and reimplementing them in Node is precisely the second implementation this ADR exists to
prevent.

---

## Decision

`packages/fingerprint` is the single implementation. It is written against the standard DOM API
only — no framework, no Node built-ins, no browser-only globals beyond `document` and `window` —
so the same source runs in both places.

The extension consumes it by importing it.

The indexer consumes it by **bundling the same package with esbuild and injecting it into the
page under test** (`apps/indexer/src/crawl/fingerprint-bundle.ts`). The bundle is built once per
process from TypeScript source, so there is no compiled artifact to fall out of date, and it is
installed with `addInitScript` so it is present before the application's own scripts run on every
document, including after a client-side navigation. All DOM-touching indexer code lives in one
file, `apps/indexer/src/crawl/in-page/collect.ts`.

The package's public surface is four functions:

```ts
computeFingerprint(el: Element, ctx: PageContext): ElementFingerprint
scoreCandidate(fp: ElementFingerprint, live: Element): number
resolve(query: ScopedQuery, candidates: Element[]): ResolutionResult
structuralHash(root: Element): string
```

Signal weights are an exported, overridable config object (`packages/fingerprint/src/config.ts`),
not constants at the call sites, because they are tuned per corpus and both consumers must be
retunable together.

`CLAUDE.md` rule #4 makes this non-negotiable, and `docs/BUILD-PLAN.md` ships a recovery prompt
for the case where an agent writes resolution logic anywhere else.

---

## Consequences

### What this buys

- Fingerprints computed at index time and read at runtime are computed by the same code, by
  construction. The class of bug where memory silently stops matching reality is gone.
- The UI materializer (`docs/TEST-DATA-ENGINE.md § 4`, Phase 15) is nearly free: driving a create
  form is the runtime executor pointed at a form, using the same resolver. Had there been two
  implementations, it would have been a third.
- Retuning the weights is one change reviewed in one diff, and `pnpm --filter fingerprint test`
  covers both consumers' behaviour at once.

### What it costs

- **The package is constrained to the DOM API forever.** No `jsdom`, no `happy-dom` in the
  runtime path (they appear in tests only), no Node crypto — `packages/fingerprint/src/sha256.ts`
  exists because the package needs a hash that works in both places. Every future signal has to
  be implementable inside that box or it does not get added.
- **The indexer pays a bundling step.** esbuild compiles the package on first use of every
  worker process, and a checkout where `packages/fingerprint` has not been built produces an
  unresolved-import error that needs a special-cased explanation
  (`buildOrExplain` in `fingerprint-bundle.ts`) to be intelligible.
- **Injected code runs in the customer's page.** `addInitScript` puts our bundle in the
  application under test during a crawl. It is read-only and it stamps one marker attribute
  (`data-wispr-el`), but it is still our code executing inside a customer's system, and that is a
  question security review will ask.
- **Accessible-name computation is a documented subset, not the full ARIA algorithm.** Pulling in
  a complete implementation would violate the dependency constraint above, so
  `packages/fingerprint/src/accname.ts` implements the common cases and documents what it does
  not cover. That gap is a known source of scoring error on exotic markup.
- **Any change to the package is a change to both services at once.** There is no way to roll a
  fingerprint change out to the indexer and observe it before the extension sees it. Version
  skew between a shipped extension and a deployed indexer is therefore a real hazard that the
  `memory_version` mechanism only partly contains.

### What would reverse it

Only a change in what the two consumers need. If the indexer ever had to fingerprint something
the extension cannot see — a server-rendered artifact, a mobile surface — the shared-package
constraint would be the wrong shape, and the right move would be to split *what is computed*
rather than to duplicate *how*. Duplicating the implementation is never the answer.
