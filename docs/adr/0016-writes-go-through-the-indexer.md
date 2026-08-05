# 0016 — Every write to the app under test goes through the indexer

**Status:** Accepted
**Decided:** 2026-08-05 (Phase 16, PRs #17–#19)

---

## Context

`docs/TEST-DATA-ENGINE.md` § 4 specifies three materializers and one sentence about how the
fastest of them authenticates:

> **Auth:** reuse the tester's live session (cookie/bearer from the attached tab). WisprTest never
> stores app credentials.

Taken literally, that is not implementable, and the reason is structural rather than incidental:

- **The gateway has no browser.** It is a Fastify service. A cookie belonging to the tester's tab
  exists in Chrome, in a process on their laptop, on the other side of the network.
- **`SeedExecuteRequest` deliberately carries nothing but a plan id.** That shape is what makes
  "the bytes that were previewed are the bytes that get written" true rather than aspirational
  (see `packages/protocol/src/seeding.ts`). Adding a credential field to it would open exactly the
  seam the schema exists to close.
- **Storing the credential instead is forbidden** by the same sentence, and by ARCHITECTURE § 8.

Phase 15 had already met this problem for the UI adapter and answered it: the UI materializer runs
on the indexer, in a Playwright context that applies the application's stored `AuthProfile` — a
pointer into the tenant's secret store, never a credential (`db/migrations/…_application_auth_profile.sql`).

So Phase 16 was choosing between repeating that answer for the two new adapters, inventing a
second one for them, or shipping an API adapter that only works against endpoints needing no
authentication at all.

---

## Decision

**The gateway owns the chain, the policy and the ledger. The indexer owns every outbound request
to the customer's application.**

All three adapters — UI, API, fixture — execute on the indexer's seed worker. The API and fixture
adapters issue their requests through `page.request`, which shares the browser context's cookie
jar, so a replay carries exactly the cookies the application set when the worker logged in.

`packages/protocol`'s `SeedJob` is the boundary: six operations, one per adapter per direction.
The gateway decides *which* adapter runs and fills the observed payload template; the worker only
delivers it.

---

## Consequences

**§ 4's property is preserved even though its mechanism is not.** No session is copied anywhere to
make the request — the jar issuing it *is* the authenticated one. What differs from the letter of
the spec is whose session: the background worker's, established from the application's configured
auth profile, rather than the tester's tab.

**One SSRF gate, not two.** `apps/indexer/src/crawl/url-policy.ts` already validates scheme,
embedded credentials, origin allowlist and address class on every navigation. Both new adapters
take their target from a database column — an observed spec, or a customer-configured `command` —
so both are exactly the input that gate exists for. Putting them in the gateway would have meant a
second implementation, and the one that drifted would be the one nobody was looking at.

**Bearer-authenticated APIs cannot be replayed.** `network-observer.ts` records that an
`Authorization` header was present and never its value, which is correct. A bearer token lives in
the application's own JavaScript, and a cookie jar will not produce it. `canHandle` refuses these
with a concrete reason and the chain falls through to the UI adapter. For token-auth SPAs — a
large share of real applications — the API adapter therefore never runs. Closing that needs a
deliberate token-capture mechanism with its own threat model, and it is not this decision.

**A fixture endpoint must live on the application's own origin.** The seed policy allowlists
exactly that origin. A customer whose seeder is on a separate host cannot use the adapter yet, and
gets a refusal saying so. The alternative — letting a database column dial anywhere — is an SSRF
reachable through configuration.

**`command` is an HTTP endpoint and nothing else.** § 4 describes the fixture adapter as an
"endpoint, factory, or SQL". Two of those three readings are arbitrary code execution driven by a
stored string. Only the endpoint reading is implemented.

**An API-created record often cannot be reverted through the UI.** A browser that submitted a form
ends up on the record's page and learns its path for free; a replay learns an identifier and
nothing about where the record is rendered. The gateway reconstructs the path from the route the
delete control was indexed on, which works when that control is on a detail route (`/orders/:id`)
and cannot when it is a list-row button (`/orders`) — there is nothing to substitute, and picking
a row by score is the single worst thing this system can do. The second case reports
`inverseOp: { kind: 'none' }` with its reason, shown in the preview *before* the record is created,
per § 5. Recording the entity's detail route at index time would close it; the observers already
learn route patterns, so this is a small change in a module Phase 16 did not own.

---

## Alternatives considered

**The gateway issues the request itself.** No protocol change and no indexer change — the API
adapter would live entirely in `apps/gateway/src/materializers/`, as `BUILD-PLAN.md` Phase 16's
"Touches" line suggests. But with no credentials it could only handle `auth: 'none'`, so it would
refuse almost every real create endpoint. An adapter that is first in the chain and never runs is
worse than no adapter, because it makes the chain look richer than it is.

**The extension calls from the attached tab.** Closest to § 4's wording, and it would genuinely use
the tester's own session. It also splits the fallback chain across the network: the gateway would
hand a pending node back to the client mid-chain and resume on a client-reported result, with the
write landing outside the transaction that records the ledger. Seeding is action class S. A write
the gateway is told about rather than one it performed is the wrong shape for the one operation in
the product that must be auditable.
