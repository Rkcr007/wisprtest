# 0017 — A reserved voice phrase is a bare utterance; a verb reaches the application

**Status:** Accepted
**Decided:** 2026-08-31 (Voice Correction & Safety Track, slice 1)

---

## Context

WisprTest is voice-native, and a tester who has just watched the runtime do the wrong thing needs
a way to say so *in the medium they are already working in*. The proposed workstream is a small
**reserved lexicon** — "stop", "that was wrong", "undo that", "run that again" — that the runtime
recognises deterministically rather than resolving against the application.

The stated design rule for the workstream is:

> The phrase should never itself modify the release gate blindly. Instead: spoken trigger →
> deterministic correction event → evidence/context → release-gate decision.

The proposal also asked that reserved phrases "have priority over normal application commands
while the voice engine is in an active testing session". That is the part that needs deciding,
because taken literally it is not safe.

**The collision is not hypothetical, and it is not rare.** The words a person reaches for to
interrupt a machine are the same words enterprise applications print on buttons. "Stop" is a
control on every job runner and every media surface. "Cancel" is in every dialog in every
application ever shipped. "Continue" is on every wizard step and every checkout. The runtime's own
verb lexicon (`apps/extension/src/speculation/intent.ts`) already maps `confirm`, `accept`,
`approve`, `submit` and `save` to `click` for exactly this reason — they are labels.

There is a second, structural reason this matters. `CLAUDE.md` § "What is generic vs what is
per-application" is the distinction the whole codebase turns on. A reserved lexicon is **generic**:
written once, identical for every customer. An element label is **per-application**: learned by the
indexer, held in memory, never hardcoded. Giving a generic word blanket priority means a generic
table silently overrides learned per-application knowledge — the exact inversion the rule exists to
prevent. On a screen with a Stop button, the app's own vocabulary is the more specific and better
evidenced claim about what "stop" means.

And there is a third: without a rule, the meaning of a word depends on what happens to be rendered.
"Stop" halts on one screen and clicks on the next. A tester cannot build a reflex on that, which
defeats the point of a reserved word.

---

## Decision

**A reserved phrase is recognised only as a complete utterance carrying no verb. Prefixing any
verb from the runtime lexicon reaches the application instead.**

```
"stop"              → reserved: halt
"stop stop"         → reserved: halt          (repetition is one utterance, still bare)
"click stop"        → application: click the control named "Stop"
"press stop"        → application: click the control named "Stop"
"stop the import"   → application: not a bare match; parsed as a command
```

Three properties follow, and they are the reason this rule was chosen over the alternatives:

1. **It is decided lexically, before any resolution.** No candidate set is consulted, no score is
   compared. A `normalizePhrase` and one map lookup, which is what lets it sit on the hot path
   ahead of everything else.
2. **The same words always mean the same thing.** A reserved phrase does not change meaning with
   the screen, so the reflex a tester builds on Monday still works on Friday.
3. **The escape hatch is a word, not a menu.** Reaching the application's own "Stop" costs one
   verb, said in the same breath. It does not cost a numbered disambiguation list.

**Reserved phrases are matched on the final transcript only, never on a partial.** A partial
hypothesis of "stop the import job" reads "stop" on its way past, and firing on it would halt an
utterance the tester never finished saying. Recognising on the final still precedes every
committing action, because class C requires a final transcript *plus* a stability window *plus* an
explicit yes (`speculation/controller.ts`) — a halt on the final transcript is always in time.

**The check runs first, ahead of the open-disambiguation branch and the parser.** That is what
"reserved" means, and placing it first makes the precedence a property of the code's shape rather
than an accident of which branch happened to match.

**Slice 1 ships exactly one intent: `halt`.** `ReservedIntent` is a closed union containing the
intents that have a handler today, and `halt`'s handler already exists — `controller.cancel()`,
documented since Phase 10 as "abandon the current utterance, rolling back and recording a staged
commit that never ran". The other proposed phrases are deferred to the slices that implement their
effects rather than shipped as recognised words that do nothing.

**A halt writes nothing into the release gate.** It dispatches no action, so it produces no
`executed` step, and the gate's numerator is filed by hand rather than inferred. Saying "stop"
therefore moves no number in
`(false_execution_total − withdrawn) / session_steps_total{outcome="executed"}` — the workstream's
own safety rule, applied to its first phrase.

**A halt is also not yet recorded as a *refusal*, and that is a limit rather than an omission.**
The intent was to emit the staged commit as `rejected` instead of `staged`, on the grounds that
"overtaken by the next thing the tester said" and "refused out loud" are different facts and only
the second is evidence. It is not reachable. A spoken "stop" is a new utterance, so `onSpeechOnset`
has already run by the time the word is recognised, and that call flushes any staged committing
action as `staged` and clears it — nothing is left for the halt to mark. Shipping the `rejected`
branch anyway would have been a path no tester can reach, which `CLAUDE.md` rule 1 forbids, so it
was removed. Distinguishing the two requires the halt to arrive *inside* the utterance it
interrupts. That is barge-in, and this is the reason it is the track's next slice rather than a
refinement of this one.

---

## Alternatives rejected

**Blanket priority for reserved words.** What the proposal asked for. Rejected: it removes
"Continue" and "Cancel" from the tester's reach on precisely the wizard and dialog screens where
those are the only controls that matter, and it inverts the generic/per-application rule above.

**Arbitrate against the scoped candidate set** — resolve the phrase, and let the application win
when a visible element matches at or above the classify threshold. This was the first proposal, and
it is wrong for two reasons that only became clear against the code. It makes a word's meaning
depend on what is rendered, which is the non-determinism the tester feels most. And it puts a
resolver call ahead of every utterance on the hot path to answer a question that a lexical rule
answers for free.

**Disambiguate the collision** — "did you mean the Stop button, or stop testing?" — reusing the
numbered choice group the HUD already renders. Honest, and genuinely tempting because the machinery
exists. Rejected for halt specifically: a prompt is the one response an interruption cannot afford,
and answering it costs more words than the verb-prefixed form does.

**A wake word** — "Wispr, stop". Unambiguous, and no application vocabulary is taken away. Rejected
as a worse trade for the phrase that most needs to be fast: an interruption is the moment a tester
is least able to remember a prefix, and the cost being avoided is one verb on a rarer utterance.

---

## Consequences

**Bare "stop", "cancel", "wait", "hold on" and "never mind" no longer reach the application.**
This is a real capability removed, not a theoretical one: today an utterance with no verb resolves
as a `click` against the scoped set, so bare "cancel" currently presses a dialog's Cancel button
and after this change it does not. The verb-prefixed form is the replacement, and the asymmetry is
what makes the trade defensible — the same asymmetry `seed/intent.ts` reasons from. Halting when
the tester meant the button costs one repeated utterance and changes nothing on the screen. Clicking
the button when the tester meant to halt dismisses a dialog, and that is a state change made by a
runtime that was told to stop.

**"Abort" is deliberately not reserved.** It is jargon, so testers reach for it rarely, and the
applications where it *is* said — CI, job runners, batch tooling — are exactly the ones where it is
also a button, and where halting the tool and aborting the job are catastrophically different
actions. The general rule would handle it safely; it is excluded because the benefit does not
justify taking the word.

**The lexicon is generic and lives in the extension, not in memory.** It is not learned, not
per-tenant, and not per-application. It is overridable through the detector's options for the same
reason every other lexicon in this codebase is — a locale pack is a different table, not an edit to
this one — but there is no per-application override, because an application must not be able to
redefine what "stop" means to the tool testing it.

**Nothing crosses a process boundary, so `packages/protocol` is unchanged.** Recognition, halt and
the resulting step are all in-extension, and the step is an existing `SessionStep` with an existing
`ActionOutcome`. The slices that follow will need contract changes; this one does not, which is why
it is a single-directory track rather than a serialized contract PR.

**What would have to become true to reverse this.** If memory ever carried per-element
reversibility (the extension already anticipates this — `speculation/classify.ts` describes
narrowing specific clicks to `R` from learned knowledge), then a collision could be arbitrated on
what the control actually *does* rather than on grammar, and a bare "cancel" could be routed to a
control known to be reversible. That is a better answer than this one. It needs indexing to
classify control effects, which it does not do today.
