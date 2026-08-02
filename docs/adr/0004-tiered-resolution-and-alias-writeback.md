# 0004 — Three resolution tiers, and the T2 alias write-back

**Status:** Accepted
**Decided:** 2026-07-29 (`c255601 feat(resolve): T2 escalation and the alias write-back loop`).
The tier structure itself predates it: `5732886` (fingerprint scoring) and `969893a` (T0/T1).

---

## Context

"Which element does this phrase mean?" is a hard question in general and an easy question almost
always. Most utterances a tester says on a screen they have used before are utterances they have
said before, on that screen, meaning that element.

An architecture that treats every utterance as the hard case pays the hard case's price on every
command. That is the entire difference between this product and a slower one: sending every
phrase to a language model produces correct answers in about a second, which is worse than
useless when the tester's alternative is clicking the button.

Two things make the easy case easy:

- **Scoping.** The runtime state engine (`apps/extension/src/runtime/`) narrows the candidate set
  from thousands of DOM nodes to the dozens currently visible *and* reachable. Resolution against
  the full document would be both slower and less accurate — "approve" is ambiguous across a
  document and unambiguous on a screen.
- **Memory.** A phrase that resolved once can resolve by lookup forever after, if something
  writes the answer down.

The second is the one that compounds, and it is the one most likely to be skipped, because a T2
implementation *works* without it. It just never gets faster.

---

## Decision

Resolution is three tiers with a hard budget each, tried in order, escalating only on a
below-threshold result. `CLAUDE.md § "Resolution tiers"` is the contract:

| Tier | Mechanism | Budget | Target share | Implementation |
|------|-----------|--------|--------------|----------------|
| T0 | Exact / alias hit in the in-memory index | < 15 ms | > 80% | `apps/extension/src/resolver/tier0.ts` |
| T1 | Local embedding kNN over the scoped set | < 40 ms | ~15% | `tier1.ts` + `browser-embedder.ts` |
| T2 | Small fast model, scoped candidates in the prompt | < 800 ms | < 5% | `tier2.ts` → `POST /v1/resolve/escalate` |

T1 runs a quantized bge-small ONNX model bundled with the extension
(`dist/models/bge-small/model_quantized.onnx`) through onnxruntime-web's WASM backend, in the
content script. It embeds only the scoped candidates' accessible names, cached per
`stateFingerprint`, so repeat lookups on the same screen cost nothing.

T2 is the only tier that leaves the device. It is the gateway's job, not the extension's, because
that is where the model credential lives and where redaction can be enforced independently of
what the client claims to have sent.

**Every T2 resolution above threshold writes back an alias.** The queue flushes in batches every
10 s and on detach (`apps/extension/src/resolver/writeback.ts`), lands at
`POST /v1/memory/aliases`, and is deduplicated with `hits` incremented on conflict. A correction
made through the disambiguation UI is written back too — a tester picking the right answer from a
ranked list is the highest-quality signal the system can get, and it is free.

Thresholds live in one place (`apps/extension/src/resolver/config.ts`) and mirror
`packages/fingerprint`'s: `resolutionThreshold 0.72`, `t1Threshold 0.62`, `t2Threshold 0.70`.
`t2Threshold` is set *above* `t1Threshold` deliberately: a T2 answer becomes durable memory, so
it must clear a higher bar than one that is used once and discarded.

Below threshold at every tier, the resolver returns ranked candidates for disambiguation rather
than picking. There is no tier that guesses.

`docs/ARCHITECTURE.md § 6` names the tier distribution as the single best health metric for the
product: if the T0 share is not climbing, the compounding loop is broken.

---

## Consequences

### What this buys

- The common case is a hash lookup, and the uncommon case pays for itself by becoming common-case
  next time. Cost per command falls with usage rather than staying flat.
- The T2 bill is bounded by novelty, not by traffic. A mature tenant on a stable application
  should approach zero escalations.
- Corrections are captured. The disambiguation UI is not a failure path, it is a labelling
  interface the tester is already motivated to use.
- Every tier degrades into the next one rather than into an error. A T2 timeout
  (`resolution_timeout`, 504) sends the extension to disambiguation with the T1 candidates it
  already holds. The worst outcome at T2 is a tester picking from a list — never a wrong click.

### What it costs

- **Three code paths that must agree.** T0, T1 and T2 each produce a `ResolutionResult` with a
  confidence on the same scale, and those scales are not naturally comparable — a cosine
  similarity and a model's self-reported confidence are different quantities being compared
  against thresholds tuned by hand. This calibration is the least principled part of the system.
- **The bundled model is extension weight.** A quantized bge-small plus the ORT WASM runtime ship
  in every install and load on first use. That is real download size and a first-resolution
  latency spike that the per-`stateFingerprint` cache hides only after the first utterance on a
  screen.
- **Write-back makes memory mutable at runtime.** Aliases accumulate from live traffic, so memory
  is no longer purely a product of indexing. A bad T2 answer above threshold becomes a fast,
  confident, *wrong* T0 hit — and it persists. `tier0.ts` mitigates this by discounting an alias
  whose bound element no longer matches its stored fingerprint, pushing toward disambiguation
  rather than a confident wrong hit, but nothing today removes a bad alias except a human editing
  it in the console.
- **Vocabulary is per tenant, structure is not.** `aliases.tenant_id` is part of the uniqueness
  constraint precisely so one customer's phrasing never leaks into another's. That is correct,
  and it means the compounding asset does not compound *across* customers. Each tenant learns the
  same application's vocabulary independently.
- **T2 is a dependency on a model provider** with a hard 800 ms budget, one repair retry, and a
  configured fallback model (`MODEL_PRIMARY` / `MODEL_FALLBACK`). It is the only place a
  customer's redacted phrasing leaves our infrastructure, and it is the reason
  `apps/gateway/src/model/escalate.ts` redacts a second time rather than trusting the client.

### Known divergence: screen-scoped aliases cannot be stored

`tier0.ts` builds two alias maps and documents the intent explicitly: "A screen-scoped alias
(`stateFingerprint` set) shadows an app-wide one for the same phrase — the same words can mean
different controls on different screens, and the more specific mapping wins."

The database cannot represent that. The uniqueness constraint is

```sql
CREATE UNIQUE INDEX aliases_tenant_version_phrase_key
    ON aliases (tenant_id, memory_version_id, phrase);
```

with no `state_fingerprint` column in the key, and `upsertAliases`
(`apps/gateway/src/db/memory-repository.ts`) conflicts on exactly those three columns and
**overwrites** `element_id` and `state_fingerprint` from the incoming row.

So "approve" learned on the Orders screen and "approve" learned on the Invoices screen are the
same row. The second write-back silently retargets the first. The resolver's shadowing logic is
correct and unreachable, because a snapshot can never contain two scoped aliases with the same
phrase.

This is not resolved here. Fixing it means either widening the index to include
`state_fingerprint` (with a `COALESCE`-based partial index or a sentinel, because NULLs are
distinct in a unique index) or deciding that aliases are deliberately app-wide and deleting the
shadowing logic. Whichever is chosen needs its own ADR — the two options have different
consequences for how much a tenant learns per screen.

### What would reverse it

The tier boundaries move if the economics move. If an on-device model gets good enough and fast
enough to run inside the 40 ms budget, T1 and T2 merge and the write-back becomes an optimisation
rather than the moat. The write-back itself does not reverse: it is cheap, and its value does not
depend on what the tiers cost.
