# 0006 — Actions dispatch through CDP, not synthetic DOM events

**Status:** Accepted
**Decided:** 2026-07-29 (`ce5c299 feat(runtime): speculation controller, CDP executor, and intent parser`)

---

## Context

Once the resolver has picked an element, something has to press it.

The obvious way is `element.click()` or `element.dispatchEvent(new MouseEvent('click'))`. Both
produce an event with `isTrusted === false`. The DOM spec draws that line deliberately: a
synthetic event is one that a script created, and an application is entitled to treat it
differently from a real user's input.

Enterprise applications do. Payment forms, approval workflows, admin destructive actions, and
anything behind a bot-mitigation layer routinely check `isTrusted` — precisely on the controls
this product most needs to operate correctly, and precisely the ones classified `C` in
[ADR 0005](0005-reversibility-taxonomy.md). An approve button that ignores a synthetic click is
not a bug in the application; it is the application working.

A second-order problem: synthetic events skip the browser's own input pipeline. Focus does not
move the way it would, `:active` and `:focus-visible` do not resolve the way they would,
composition and IME behaviour differ, and a typed value arrives without the intermediate
`keydown`/`keypress`/`input` sequence some frameworks depend on. Every one of those is a place
where "WisprTest did it" and "a tester did it" diverge — which defeats the purpose of a manual QA
tool.

---

## Decision

`ActionExecutor` dispatches through the Chrome DevTools Protocol — `Input.dispatchMouseEvent`,
`Input.dispatchKeyEvent` — via `chrome.debugger`. Implementation in
`apps/extension/src/executor/cdp.ts` and `apps/extension/src/background/cdp-dispatch.ts`.

CDP input events enter the browser's real input pipeline. They carry `isTrusted === true`, move
focus properly, and produce the full event sequence an application expects. Typing uses realistic
inter-key delays for the same reason.

The `debugger` permission is requested in the manifest with the longest justification in the file
(`apps/extension/src/manifest.ts`), and it is bounded:

- **Attached lazily** — on the first command a tester issues on a tab, not on install and not on
  page load. A tab the tester only browses never has a debugger attached.
- **Detached when the tab goes away.**
- **Visible** — Chrome shows its own "WisprTest started debugging this browser" banner whenever it
  is attached. The tester always knows when WisprTest is able to act, and they cannot be tricked
  about it, because that banner is Chrome's and not ours.

Every dispatched action emits a `SessionStep` with tier, latency, confidence, action class and
evidence references.

---

## Consequences

### What this buys

- Class `C` controls actually work. An approve button that refuses synthetic input honours a CDP
  click, so the product can operate the workflows customers most want tested.
- What WisprTest does and what a tester does are the same input, at the browser level. That is
  the correctness argument for a QA tool, and it is stronger than the compatibility argument.
- Focus, IME, and framework event expectations come out right without per-framework workarounds.

### What it costs

- **`debugger` is the most invasive permission in the manifest**, and it is the one an enterprise
  security review will stop on. It grants, in principle, full DevTools access to the attached
  tab. The mitigations above are real but they are policy in our code, not a capability boundary
  enforced by Chrome.
- **The Chrome debugging banner is permanently visible while attached.** Testers will ask to turn
  it off. It cannot be turned off, and it should not be — it is the honest signal that WisprTest
  can act on this tab, and arguing it away would be arguing away the one thing that makes the
  permission acceptable.
- **DevTools is single-client per tab.** A tester who opens Chrome DevTools on a tab WisprTest is
  attached to will contend for it. This is a support burden on exactly the population most likely
  to open DevTools.
- **It hard-binds the product to Chromium.** [ADR 0001](0001-in-process-mv3-runtime.md) already
  costs cross-browser support; this makes it structural rather than incidental. Firefox has no
  equivalent transport for trusted synthetic input from an extension.
- **Dispatch is asynchronous and cross-context.** `chrome.debugger` lives in the service worker,
  the resolver lives in the content script, so every action crosses a message boundary — inside a
  p95 < 30 ms dispatch budget, in a worker that may have been terminated since the last command.
  `background/cdp-dispatch.ts` exists entirely to manage that.
- **CDP dispatches by coordinates, not by element.** `Input.dispatchMouseEvent` takes a point.
  The executor has to translate a resolved element into a click point and be sure nothing moved
  in between — which is why `ActionRequest` carries `stateFingerprint` and a mismatch at dispatch
  time is `action_target_stale` (409) rather than a click at a stale position.

### What would reverse it

A trusted-input capability that does not require `debugger`. If Chrome ever exposes one — or if a
customer segment turns out to have no `isTrusted` checks at all and to weight the permission
review more heavily than the coverage — a synthetic-event executor behind a per-application
setting becomes defensible. It should be a setting, never a default: the default has to be the
one that makes the test faithful.
