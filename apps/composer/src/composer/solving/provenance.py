"""Why every composed field holds the value it does.

docs/TEST-DATA-ENGINE.md § 3 calls this non-negotiable, and the reason is not audit trails — it
is adoption. A preview card that says `amount: 46,200` and nothing else asks the tester to trust
a number that appeared from nowhere. One that says "computed as the sum of amount across 3 lines,
the way this application computes it" is a tool they can reason about. The doc's own worked
example of a *good* explanation is "matched from 64 known accounts"; its example of a bad one is
"generated". Every method below is written to land on the first side of that line.

## One entry per field, last writer wins

The solve order in § 3 deliberately lets a later stage overwrite an earlier one: a `status` the
sampler drew by frequency is replaced when a predicate requires it to be something else. The
preview must show *why the value it is showing* was chosen, not the history of the field, so the
builder keeps one entry per field and replaces it in place — preserving the order fields were
first touched, so the card reads in the order the engine worked.

## Confidence is carried, not invented

Every method takes the confidence from whatever produced the value: the parse confidence for
something the tester asked for, the sampler's own score for a draw, the learned rule's confidence
for a derived field. Nothing here computes a score of its own, because nothing here knows
anything the producer did not.

## The one case that has no value yet

A reference to a record this same plan will create cannot hold a value at composition time — the
application has not issued the identifier. `pending_reference` records that honestly, with a null
value and an explanation naming the node the gateway will take the identifier from. Its source is
`default` rather than `reference_matched` because nothing was matched: the closed vocabulary has
no member for "the plan will fill this in", and stretching `reference_matched` to cover it would
make the one source a tester most needs to trust mean two different things.
"""

from __future__ import annotations

from composer.protocol.models import ProvenanceEntry, ProvenanceSource
from composer.solving.sampler import SampledValue


def _clamp(confidence: float) -> float:
    """Keep a carried confidence inside the contract's closed range."""
    return min(max(confidence, 0.0), 1.0)


class ProvenanceBuilder:
    """Accumulates one explanation per field of one composition node."""

    def __init__(self) -> None:
        # Insertion-ordered by first touch: a field the predicate solver later overrides keeps
        # the position it had when it was first filled, so the preview does not reshuffle.
        self._entries: dict[str, ProvenanceEntry] = {}

    # ── Recording ─────────────────────────────────────────────────────────────────────────

    def record(
        self,
        field: str,
        value: object,
        source: ProvenanceSource,
        explanation: str,
        confidence: float,
    ) -> None:
        """The general form. The named methods below exist so callers cannot phrase it badly."""
        self._entries[field] = ProvenanceEntry(
            field=field,
            value=value,
            source=source,
            explanation=explanation,
            confidence=_clamp(confidence),
        )

    def requested(self, field: str, value: object, confidence: float) -> None:
        """The tester said this value out loud."""
        self.record(
            field,
            value,
            ProvenanceSource.REQUESTED,
            f"you asked for {field} to be {value!r}",
            confidence,
        )

    def requested_within_bounds(
        self, field: str, value: object, requirement: str, confidence: float
    ) -> None:
        """The tester bounded the field rather than naming a value, e.g. "over £50,000"."""
        self.record(
            field,
            value,
            ProvenanceSource.REQUESTED,
            f"you asked for {field} to be {requirement}, and this is the value chosen to satisfy "
            "that while staying inside what this application has been seen to hold",
            confidence,
        )

    def reference_matched(
        self,
        field: str,
        external_ref: str,
        *,
        entity: str,
        phrase: str | None,
        pool_size: int,
        confidence: float,
    ) -> None:
        """A reference field pointed at a record that already exists.

        Both phrasings name the size of the pool the match came out of, because "matched from 64
        known accounts" is the difference between a tester believing the engine looked and a
        tester believing it guessed.
        """
        explanation = (
            f"matched {phrase!r} to {external_ref} from the {pool_size} known "
            f"{entity} records you are working with"
            if phrase is not None
            else (
                f"reused the existing {entity} {external_ref}, one of {pool_size} you are working "
                "with — nothing you said asked for a new one"
            )
        )
        self.record(field, external_ref, ProvenanceSource.REFERENCE_MATCHED, explanation, confidence)

    def pending_reference(self, field: str, *, entity: str, node_id: str) -> None:
        """A reference to a record this plan creates, whose identifier does not exist yet."""
        self.record(
            field,
            None,
            ProvenanceSource.DEFAULT,
            f"no existing {entity} fitted, so one is created first ({node_id}) and this field "
            "takes the identifier the application returns for it",
            1.0,
        )

    def sampled(self, field: str, drawn: SampledValue) -> None:
        """A value drawn from the application's own observed distribution.

        The explanation comes from the sampler verbatim: it is the only layer that knows which
        shape was drawn from and how much evidence stood behind it.
        """
        self.record(field, drawn.value, ProvenanceSource.SAMPLED, drawn.explanation, drawn.confidence)

    def sampled_group(
        self, field: str, *, size: int, requested: bool, explanation: str, confidence: float
    ) -> None:
        """A repeated group. The entry explains the group as a whole, not each member."""
        opening = (
            f"the {size} you asked for" if requested else f"{size}, {explanation}"
        )
        self.record(
            field,
            None,
            ProvenanceSource.REQUESTED if requested else ProvenanceSource.SAMPLED,
            f"{opening}; each one's values are drawn from what this application's "
            f"{field} actually contain",
            confidence,
        )

    def derived(self, field: str, value: object, *, description: str, confidence: float) -> None:
        """A field the application computes, computed here the same way.

        Stated as "the way this application computes it" rather than "calculated" because the
        rule was *observed to hold for every indexed record* — that is a much stronger claim than
        arithmetic, and it is the claim the tester is being asked to trust.
        """
        self.record(
            field,
            value,
            ProvenanceSource.DERIVED,
            f"computed as {description}, the way this application computes it",
            confidence,
        )

    def predicate_solved(
        self, field: str, value: object, *, predicate: str, requirement: str, confidence: float
    ) -> None:
        """A field set so a named condition holds — the "overdue ⇒ back-date due_date" case."""
        self.record(
            field,
            value,
            ProvenanceSource.PREDICATE_SOLVED,
            f"set so that {predicate!r} holds — it requires {requirement}",
            confidence,
        )

    def defaulted(self, field: str, value: object, *, reason: str, confidence: float) -> None:
        """The engine filled the field without being asked, and says exactly why."""
        self.record(field, value, ProvenanceSource.DEFAULT, reason, confidence)

    # ── Reading back ──────────────────────────────────────────────────────────────────────

    def entries(self) -> list[ProvenanceEntry]:
        return list(self._entries.values())

    def has(self, field: str) -> bool:
        return field in self._entries

    def source_of(self, field: str) -> ProvenanceSource | None:
        entry = self._entries.get(field)
        return entry.source if entry is not None else None
