# 0009 — Product Memory stores structure, never content

**Status:** Accepted
**Decided:** 2026-07-25 (`5732886` establishes the redaction pipeline; `d60052e` encodes it in the schema)

---

## Context

WisprTest indexes a customer's internal application by crawling it while logged in. That means
the crawler sees production-shaped data: a table of customer names, an order with a billing
address, an invoice with an amount, a support ticket with free text somebody typed about a real
person.

Everything downstream is a place that data could come to rest:

- `elements.accessible_name` — the highest-weighted resolution signal (0.25), and on a data table
  the accessible name of a row control *is* a customer's name.
- Log lines — one `logger.info({ element })` written during a debugging session, and a customer's
  data is in a retained index nobody remembers to purge.
- T2 prompts — the escalation sends candidate labels to a model provider.
- `field_specs.distribution` — the test data engine's whole job is to describe a customer's real
  records well enough to generate plausible new ones.

`CLAUDE.md § "PII rule"` calls this a procurement blocker, and that is the right framing.
Enterprise security review will ask what leaves the customer's environment and what is retained.
"We store accessible names" ends the conversation. There is no version of this product that ships
into a bank while storing customers' names, and retrofitting redaction into a system that assumed
raw text is not a patch — it is a data migration plus a disclosure.

---

## Decision

Memory stores **structure**. Content is hashed, redacted, or reduced to statistics before it is
persisted or placed in a prompt. Never after.

### Element names

`packages/fingerprint/src/redact.ts` is the pipeline, and there is no path around it:
`computeFingerprint` redacts *before* hashing and before storing, and the scoring functions
compare redacted forms only. The default redactor masks emails, currency amounts, phone numbers
and long digit runs, applied in a documented order (emails before phone numbers, because a local
part looks like either; currency before bare digit runs, so `$1,200.00` becomes `[amount]` rather
than `$[number].00`).

Masking is **shape-preserving** — an email becomes `[email]`, not nothing — so two names that
differed only in their PII compare equal and two that differed structurally still compare
different. That is what keeps a redacted name useful as a fingerprint signal, and it is why the
redactor cannot simply strip.

The schema enforces the outcome. `elements` has `accessible_name_hash text NOT NULL CHECK (~
'^[0-9a-f]{64}$')` and the redacted display form inside `fingerprint jsonb`. There is no column
for a raw accessible name, and the migration comment says there never will be.

The redactor must be pure and deterministic, because the indexer and the extension both run it
and a fingerprint computed by one has to match a name read by the other — see
[ADR 0002](0002-single-fingerprint-implementation.md).

### Learned schemas

`apps/indexer/src/observers/pii.ts` is the one place an observed *value* may become something
stored, and its rule is: **statistics leave; values do not.** A numeric field contributes a range
and a mean. A date field contributes two offsets. A free-text field contributes a length range
and a character class.

There is exactly one exception, behind two guards. A learned enum vocabulary *is* a set of
values — `{Draft, Pending approval, Approved}` — and the solver cannot satisfy `status = pending`
without it. So values are retained only when:

1. **The vocabulary is closed** — either the application declared it with a closed-set control,
   or the values repeat often enough across records to be a vocabulary rather than a column.
   `MAX_VOCABULARY_SIZE = 12`, `MAX_VOCABULARY_DISTINCT_RATIO = 0.25`. Twelve distinct statuses
   across a thousand orders is a vocabulary; twelve across fifteen records is a column of data
   that happens to be short.
2. **Every retained value is redacted and bounded** — `MAX_VOCABULARY_VALUE_LENGTH = 64`, because
   beyond that a "vocabulary member" is prose, and prose is content.

A learned string *prefix* is the other place a fragment of real data could escape, and
`safePrefix` exists for it.

### Logs

`apps/gateway/src/logger.ts` redacts **by key, not by value inspection**. Value inspection cannot
tell a customer's name from a button label, so it would either miss real PII or mangle ordinary
fields. A key list is blunt, but it is auditable and it fails in the safe direction. The list
covers `accessibleName`, `label`, `targetPhrase`, `utterance`, `phrase`, `text`, `textContent`,
`value`, `payload`, `password`, `token`, `authorization`, with wildcards for nesting, plus
`req.headers.authorization` and `req.headers.cookie`.

### Model prompts

`apps/gateway/src/model/escalate.ts` redacts the utterance and every candidate label again —
using the same shared `defaultRedactor` — immediately before they are rendered into a prompt,
even though the contract already requires redacted text. Defence in depth over a client-supplied
guarantee: the gateway is the process that would be liable, so the gateway does the redacting.

### Evidence and audio

Session evidence (screenshots, DOM snapshots) is redacted before upload and stored in object
storage with only a reference and content hash in the database. Raw audio is never persisted;
transcripts live in memory for the session only.

---

## Consequences

### What this buys

- The procurement answer is short: element text is hashed and redacted before it is written, logs
  cannot carry it, prompts cannot carry it, and no raw observed value reaches `field_specs`.
- The largest accidental-retention surface — logs — is closed structurally rather than by
  reminding people.
- Redaction being deterministic and shared means it is also *testable* as a single thing, rather
  than as a property of every call site.

### What it costs

- **Resolution accuracy is degraded, by design.** The highest-weighted signal is a masked string.
  Two rows whose only distinguishing feature is a customer name are `[redacted]`-identical, so
  they are structurally indistinguishable and resolution falls to ordinal
  (`Ordinal within parent group`, weight 0.08) and geometry (0.05). "Click the Acme row" is a
  request the fingerprint system cannot serve well and never will.
- **Redaction is regex-based, so it is both over- and under-inclusive.** A product SKU that looks
  like a phone number becomes `[phone]`. A surname is not matched by anything and passes through.
  The rules in `redact.ts` are a heuristic presented as a guarantee, and that gap should be stated
  honestly to customers rather than papered over. The mitigation is the key-based log redaction
  and the schema having no raw-name column — belt and braces around a fallible scrubber.
- **Key-based log redaction masks useful fields too.** `value` and `payload` are censored
  everywhere, which is exactly the field you want while debugging a materialization failure.
  Operators will feel this in the seed and drift runbooks, and the answer is more specific field
  names in log lines — never a carve-out in the list.
- **Statistics-only schemas limit what the sampler can do.** No real value means no learned
  correlation between fields, no realistic joint distribution, and no reproduction of the format
  quirks that a customer's validation actually enforces. `docs/TEST-DATA-ENGINE.md` accepts this:
  seeded data is plausible per field, not jointly realistic.
- **One documented exception already exists.** `ExistingRecord` in
  `packages/protocol/src/composition.ts` carries full records from the application under test, so
  reference resolution can determine that "Acme Industrial" exists. That data is never persisted
  and never sent to a model provider, but the claim "raw text from a customer's application has
  no representation in this contract at all" is no longer true, and the protocol header was
  amended rather than left as a comfortable falsehood. Any future exception should be recorded
  the same way.

### What would reverse it

Nothing. The direction of travel is the other way: the exception list should shrink, and each
entry on it should carry the two enforceable guarantees — never persisted, never sent to a model
provider — with a test asserting both.
