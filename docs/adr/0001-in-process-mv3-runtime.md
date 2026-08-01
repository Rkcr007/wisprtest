# 0001 — The hot path runs in-process in an MV3 extension

**Status:** Accepted
**Decided:** 2026-07-26 (`57504e5 feat(extension): MV3 shell, shadow-DOM HUD, and the design system`)
**Supersedes:** —

---

## Context

The product thesis is `Remember → Execute`, not `Think → Execute`: expensive reasoning happens
once at indexing time, and runtime is a lookup. That thesis only pays if runtime is actually
fast. `CLAUDE.md § "Performance budgets"` sets speech onset → reticle at p95 < 400 ms and T0
resolution at p99 < 15 ms.

A 15 ms p99 budget does not survive a network hop. A single round trip to a control plane —
even one in the same region, even on a warm connection — is 30–80 ms before the server does any
work, and enterprise QA testers are frequently on a VPN into a corporate network where it is
worse. Any architecture where the browser asks a server "which element does this phrase mean?"
has already spent its entire resolution budget on transport.

There is a second, harder constraint. Resolution has to run against the *live* DOM: the elements
currently visible, currently reachable, currently not behind a modal. Shipping that state
somewhere else means serialising thousands of DOM nodes per utterance, which is both slower than
the round trip and lossy — computed ARIA roles and layout geometry do not survive serialisation
without reimplementing the browser's own accessibility and layout engines.

The candidates considered:

| Option | Why it was rejected |
|--------|---------------------|
| Cloud service driving the browser over CDP/WebDriver | Two network hops per action. Also makes WisprTest a remote-control tool, which is a different (and much harder) security review. |
| A local native helper the page talks to | Still a hop, plus an install and an update channel per tester machine. Enterprise IT will not deploy it. |
| A bookmarklet / injected SDK the customer adds to their app | Requires the customer to ship our code in their application. That is a change to the system under test, which invalidates the test. |
| **MV3 Chrome extension, resolution in the content script** | Chosen. |

---

## Decision

The hot path — speech → intent → scoped resolve → speculate → dispatch — runs entirely inside
the extension, in the tester's browser, in the same process as the DOM it is operating.

The control plane exists, and it is used for indexing, memory snapshot delivery, alias
write-back, session ingest, composition and telemetry. It is never on the hot path. Concretely,
in `apps/extension/manifest.json`'s generated form (`apps/extension/src/manifest.ts`),
`host_permissions` contains the gateway origin **and nothing else** — the extension makes no
network request to the application under test, because it does not need to.

The one deliberate exception is T2 escalation (`POST /v1/resolve/escalate`). It is on the network
by necessity, it is budgeted at 800 ms rather than 15 ms, and it is targeted at under 5% of
commands. It is also the reason the alias write-back in [ADR 0004](0004-tiered-resolution-and-alias-writeback.md)
exists: every T2 that crosses the network buys the right never to cross it again for that phrase.

Memory is fetched once on attach — `GET /v1/memory/:appId/snapshot`, gzipped, held in the
service worker (`apps/extension/src/background/memory-client.ts`) — and served to the content
script over a typed message channel.

---

## Consequences

### What this buys

- T0 resolution is a hash lookup over an in-memory map. The 15 ms p99 budget is achievable with
  room to spare, and `pnpm --filter extension bench:resolve` enforces it in CI.
- Resolution is scoped to what is actually on screen, because the resolver can see the screen.
  `apps/extension/src/runtime/scoped-index.ts` narrows thousands of nodes to dozens, which is
  what makes T0/T1 accurate as well as fast.
- No customer application data leaves the browser during normal operation. That is a security
  review answer we get for free, and it matters more than the latency win in enterprise sales.
- The extension works against applications on private networks, behind VPNs, on `localhost`,
  and behind SSO — anywhere the tester's browser can already go. A cloud-driven browser would
  need network access into the customer's environment.

### What it costs

- **Chrome only, and Chrome ≥ 116.** `minimum_chrome_version` is 116, set by
  `chrome.storage.session.setAccessLevel`, which is what keeps the gateway token out of content
  scripts. Firefox and Safari are not a port; they are a rewrite of the transport and permission
  model. Testers who work in other browsers are not served, and "we only support Chrome" is a
  real objection in some accounts.
- **The service worker dies.** MV3 terminates an idle service worker roughly every 30 seconds.
  Everything that must survive that has to be rebuilt around it: the token refresh uses
  `chrome.alarms` rather than `setTimeout` (`apps/extension/src/background/token-client.ts`),
  the session step buffer has to survive a restart mid-session
  (`apps/extension/src/session/buffer.ts`), and the memory snapshot is refetched rather than
  assumed. This is a permanent tax on every stateful feature in the extension.
- **`getUserMedia` is unavailable in the worker.** The entire voice pipeline lives in an
  offscreen document (`apps/extension/src/voice/offscreen.ts`) reached by message passing, with
  the `offscreen` permission and a lifecycle to manage. That is a whole component that exists
  only because of the runtime choice.
- **`<all_urls>` content script.** A tester names an application on a hostname we cannot know at
  build time, and it differs per tenant and environment. `activeTab` does not work: its grant is
  revoked on navigation, and the HUD would vanish the first time the tester followed a link.
  So the extension declares the broadest content-script match there is. `manifest.ts` justifies
  it inline and Phase 19's security pass reviews it, but it remains the most invasive thing we
  ask an enterprise to approve.
- **Debugging is harder.** A bug in the hot path reproduces on a tester's machine against a
  customer application we cannot see. Session steps and evidence
  (`apps/gateway/src/routes/sessions.ts`) exist largely to make that tractable, and they are
  not free.
- **Distribution is the Chrome Web Store or an enterprise force-install policy.** A hot-path fix
  ships on Google's review timeline, not ours. Anything we might need to fix urgently should be
  server-side data (memory, aliases, thresholds) rather than extension code — which is an
  argument that keeps recurring and should be watched.

### What would reverse it

Nothing plausible in the near term. The decision falls if the latency budgets stop mattering —
if the product turns out to tolerate 1–2 s per command — because then a cloud-driven browser
becomes viable and buys back cross-browser support and instant deployment. Treat a sustained
finding that testers do not notice the difference between 400 ms and 1500 ms as a genuine
trigger to revisit, not as a nice-to-have.
