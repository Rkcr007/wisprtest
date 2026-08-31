# 0018 — A halt fires on a stable partial, and records the commit it refused

**Status:** Accepted
**Decided:** 2026-08-31 (Voice Correction & Safety Track, slice 2)

**Amends [ADR 0017](0017-reserved-voice-lexicon-and-command-collisions.md)** on one clause. Its
collision rule — a reserved phrase is a bare utterance, and a verb reaches the application — is
unchanged and this record depends on it. What changes is 0017's "matched on the final transcript
only, never on a partial", and the consequence it drew from that.

---

## Context

Slice 1 confined reserved-phrase recognition to the final transcript. The reasoning was sound as
far as it went: a partial of "stop the import job" reads `stop` on its way past, and halting there
would abandon an utterance the tester never finished.

Two things were wrong with leaving it there.

**The final transcript is late, and lateness is the whole cost of a halt.** A final arrives when
the ASR's endpointer decides the tester has stopped talking, which is trailing silence measured in
high hundreds of milliseconds. Every other command in the product can afford that; this is the one
whose entire value is arriving before something happens.

**A halt could not record what it refused.** Slice 1 tried to emit a staged committing action as
`rejected` rather than `staged`, on the grounds that "overtaken by the next thing the tester said"
and "refused out loud" are different facts and only the second is evidence. The branch was written
and then removed, because it is unreachable: the microphone opens before the tester has said
anything, `onSpeechOnset` runs, and that already flushes any staged commit as `staged` and clears
it. By the time the word `stop` exists, there is nothing left to mark.

That second finding is the more important one. The refusal is a **near-miss**: the runtime staged
something the tester did not want, and was told so in time. It is the leading indicator for the
false-execution rate that gates every release — a false execution that was caught. Not recording it
throws away the most valuable signal the halt produces.

---

## Decision

**A bare reserved phrase standing as the whole partial arms a timer; if no revision extends it
within the barge-in window, it is taken as a halt.** Default 300 ms, injectable as
`bargeInWindowMs`. Any hypothesis that is not a bare reserved match disarms it.

Firing early is safe *by construction*, and this is the reason a partial may trigger a halt when a
partial may never trigger an action: a halt executes nothing. It cancels, and cancelling is the
operation whose worst case is that it was unnecessary. If the tester was mid-sentence, the rest of
the utterance arrives against a fresh state and is parsed as the command it always was — the
misfire costs a rolled-back speculation and a cancelled stage, not a click.

**A bare reserved phrase never reaches the resolver, on a partial or on a final.** Slice 1 returned
early only on finals, so a partial `stop` was still parsed and resolved as a command. It is a
reserved word in both cases or it is not reserved at all.

**A halt records the commit it refused as an additional `rejected` step, never as an amendment to
the `staged` one.** `session_steps` is append-only and the timeline is evidence. "It was staged,
and then it was refused" is two facts, and it reads as two rows. The refusal is found in one of two
places, which are the same fact to a tester and differ only in plumbing: the commit is still live
in this utterance, or it was flushed as superseded when the microphone reopened for the halt
itself.

**A superseded commit is refusable for exactly one utterance.** It is remembered on every reset and
overwritten by the next one, and any hypothesis that is not a bare reserved phrase drops it
immediately. A halt two minutes and three commands later is about something else, and recording a
near-miss that did not happen is worse than recording none.

**The gate is still untouched.** A halt dispatches nothing, so it produces no `executed` step, and
the numerator of
`(false_execution_total − withdrawn) / session_steps_total{outcome="executed"}` is filed by hand.
The `rejected` row sits beside the gate and moves no number in it — the track's own rule, now with
something actually recorded.

---

## Alternatives rejected

**Defer the superseded record until the utterance resolves**, so the halt could amend a single row
to `rejected` instead of appending a second. This was the first design. It requires holding the
commit's record across the onset boundary, which means either leaving it committable — a class-C
action that should have been abandoned could still be confirmed, which is the worst bug in the
product — or splitting it into a committable slot and a record slot, and then reserving its
timeline ordinal so the deferred emit does not land *after* the steps of the utterance that
superseded it. Three pieces of machinery on the most safety-critical path in the codebase, to avoid
a second row that is honest anyway.

**Emit a step for the halt itself**, carrying the halt as its own event. Rejected: a `SessionStep`
requires a `ScopedQuery` — a verb, a target phrase, a candidate set — and a halt names no element.
Filling those in would be fabricating an intent, which is the fake abstraction `CLAUDE.md` rule 1
forbids. The refused action's own intent is the truthful one to record.

**Use a shorter window, or none.** A 0 ms window is the same as halting on the first partial, which
misfires on every utterance that merely begins with a reserved word. Longer than ~300 ms and the
endpointer starts to win anyway, which is the latency this exists to avoid.

**Interrupt an in-flight dispatch.** Not implementable and not worth it: a dispatch is a DOM
operation measured in single milliseconds, and there is no point between "started" and "finished"
at which a halt could land. What is genuinely interruptible is the *speculative* effect a class-R
action leaves behind, and that is rolled back — the capture-then-maybe-undo record that lets class
R speculate at all, spent on the tester's word rather than on a diverging hypothesis.

---

## Consequences

**An utterance that begins with a bare reserved word and then pauses is halted.** "Stop… the import
job", said with a breath after the first word, cancels whatever was staged and then runs as a
command. The tester loses a stage they would have had to re-say anyway; nothing on the page changes.
This is the cost of the window and it is paid in the direction the taxonomy already leans.

**Timer behaviour is now part of the controller's contract.** `schedule` was injected for the
class-C stability window and is now shared with barge-in, so a caller supplying a fake scheduler
drives both. That is what makes the window testable without real time, and it also means a caller
that never runs scheduled callbacks will never see a barge-in halt.

**The near-miss signal exists but nothing consumes it yet.** A `rejected` step distinguishable as a
refusal is now written, and no dashboard, alert or console column reads it. That is deliberate —
the producer had to exist first, exactly as `wispr_false_execution_total` waited on its own
producer — but until something reads it, this buys a record rather than an insight.

**What would have to become true to reverse this.** If ASR endpointing got fast enough that a final
arrives within the barge-in window, the timer would be pure cost and recognition should go back to
finals only. Streaming endpointers are improving; this is worth re-measuring rather than assuming.
