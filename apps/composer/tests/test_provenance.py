"""`ProvenanceBuilder` — why every composed field holds the value it does.

docs/TEST-DATA-ENGINE.md § 3 calls this non-negotiable, and the reason is adoption rather than
audit. A preview card that says `amount: 46,200` and nothing else asks a tester to trust a number
that appeared from nowhere. The doc's example of a *good* explanation is "matched from 64 known
accounts"; its example of a bad one is "generated".

Every test here therefore asserts on the sentence, not only on the source enum. An explanation
nobody reads is decoration, and the only way to keep these specific is to check them.
"""

from __future__ import annotations

import pytest

from composer.protocol.models import ProvenanceSource
from composer.solving.provenance import ProvenanceBuilder
from composer.solving.sampler import SampledValue


def builder() -> ProvenanceBuilder:
    return ProvenanceBuilder()


# ── One entry per field ───────────────────────────────────────────────────────────────────────


def test_a_later_stage_replaces_an_earlier_one_in_place() -> None:
    """The solve order deliberately lets a predicate overwrite what the sampler drew.

    The preview must show *why the value it is showing* was chosen, not the history of the field —
    so the builder keeps one entry per field and replaces it where it stands.
    """
    entries = builder()
    entries.sampled("status", SampledValue("shipped", "drawn by frequency", 0.9))
    entries.predicate_solved(
        "status", "pending", predicate="overdue", requirement="status not to be shipped",
        confidence=0.9,
    )

    assert len(entries.entries()) == 1
    assert entries.entries()[0].value == "pending"
    assert entries.source_of("status") is ProvenanceSource.PREDICATE_SOLVED


def test_a_replaced_field_keeps_the_position_it_first_had() -> None:
    # So the card does not reshuffle between the value being drawn and the predicate fixing it.
    entries = builder()
    entries.sampled("status", SampledValue("shipped", "drawn", 0.9))
    entries.sampled("customer", SampledValue("ACME", "drawn", 0.9))
    entries.predicate_solved(
        "status", "pending", predicate="overdue", requirement="x", confidence=0.9
    )

    assert [entry.field for entry in entries.entries()] == ["status", "customer"]


def test_has_and_source_of_report_what_is_known() -> None:
    entries = builder()
    entries.requested("status", "pending", 0.9)

    assert entries.has("status")
    assert not entries.has("terms")
    assert entries.source_of("terms") is None


# ── Confidence is carried, not invented ───────────────────────────────────────────────────────


def test_confidence_comes_from_whatever_produced_the_value() -> None:
    entries = builder()
    entries.sampled("amount", SampledValue(42.0, "drawn from the observed range", 0.83))
    assert entries.entries()[0].confidence == 0.83


@pytest.mark.parametrize("given", [-1.0, 1.5])
def test_a_carried_confidence_is_clamped_into_the_contract_s_range(given: float) -> None:
    # `Confidence` is a closed [0, 1] in the contract, and a producer that hands over 1.5 should
    # produce a slightly-wrong number rather than a validation error in front of a tester.
    entries = builder()
    entries.requested("status", "pending", given)
    assert 0.0 <= entries.entries()[0].confidence <= 1.0


# ── The sentences themselves ──────────────────────────────────────────────────────────────────


def test_requested_says_the_tester_asked_for_it() -> None:
    entries = builder()
    entries.requested("status", "pending", 0.95)
    entry = entries.entries()[0]

    assert entry.source is ProvenanceSource.REQUESTED
    assert entry.explanation == "you asked for status to be 'pending'"


def test_a_bounded_request_explains_how_the_value_was_chosen() -> None:
    entries = builder()
    entries.requested_within_bounds("amount", 56_000.0, "over 50,000", 0.95)
    entry = entries.entries()[0]

    assert entry.source is ProvenanceSource.REQUESTED
    assert "you asked for amount to be over 50,000" in entry.explanation
    assert "inside what this application has been seen to hold" in entry.explanation


def test_a_matched_reference_names_the_size_of_the_pool_it_came_from() -> None:
    """"matched from 64 known accounts" is the difference between a tester believing the engine
    looked and a tester believing it guessed."""
    entries = builder()
    entries.reference_matched(
        "accountId", "ACC-1001", entity="Account", phrase="acme industrial", pool_size=64,
        confidence=0.9,
    )
    entry = entries.entries()[0]

    assert entry.source is ProvenanceSource.REFERENCE_MATCHED
    assert entry.explanation == (
        "matched 'acme industrial' to ACC-1001 from the 64 known Account records you are "
        "working with"
    )


def test_an_unprompted_reference_says_nothing_asked_for_a_new_one() -> None:
    entries = builder()
    entries.reference_matched(
        "accountId", "ACC-1001", entity="Account", phrase=None, pool_size=64, confidence=0.7
    )
    assert "nothing you said asked for a new one" in entries.entries()[0].explanation


def test_a_pending_reference_has_no_value_yet_and_says_where_one_comes_from() -> None:
    """A reference to a record this same plan creates cannot hold a value at composition time.

    Its source is `default` rather than `reference_matched` because nothing was matched: the
    closed vocabulary has no member for "the plan will fill this in", and stretching
    `reference_matched` to cover it would make the one source a tester most needs to trust mean
    two different things.
    """
    entries = builder()
    entries.pending_reference("accountId", entity="Account", node_id="account-1")
    entry = entries.entries()[0]

    assert entry.value is None
    assert entry.source is ProvenanceSource.DEFAULT
    assert "one is created first (account-1)" in entry.explanation
    assert "takes the identifier the application returns for it" in entry.explanation


def test_a_sampled_value_carries_the_sampler_s_own_sentence() -> None:
    # The sampler is the only layer that knows which shape was drawn from and how much evidence
    # stood behind it; a builder one layer up could only say "sampled".
    entries = builder()
    entries.sampled(
        "amount", SampledValue(3176.0, "drawn from the observed normal distribution over 50", 0.85)
    )
    entry = entries.entries()[0]

    assert entry.source is ProvenanceSource.SAMPLED
    assert entry.explanation == "drawn from the observed normal distribution over 50"


def test_a_group_is_explained_as_a_whole() -> None:
    requested = builder()
    requested.sampled_group(
        "lineItems", size=3, requested=True, explanation="ignored", confidence=0.95
    )
    drawn = builder()
    drawn.sampled_group(
        "lineItems", size=2, requested=False, explanation="the usual number", confidence=0.75
    )

    assert requested.entries()[0].source is ProvenanceSource.REQUESTED
    assert "the 3 you asked for" in requested.entries()[0].explanation
    assert drawn.entries()[0].source is ProvenanceSource.SAMPLED
    assert "2, the usual number" in drawn.entries()[0].explanation


def test_a_retargeted_group_says_the_requirement_was_met_through_its_members() -> None:
    """"An order over £50,000" names a total the application computes from the lines.

    The tester needs to be told that the lines were worked backwards from their number, or the
    preview shows line amounts that look arbitrary.
    """
    entries = builder()
    entries.group_retargeted(
        "lineItems", size=3, total_field="amount", total=56_898.4, confidence=0.95
    )
    entry = entries.entries()[0]

    assert entry.source is ProvenanceSource.REQUESTED
    assert "3 of them, each set so that amount comes to 56898.4" in entry.explanation
    assert "this application computes that from lineItems" in entry.explanation


def test_a_derived_field_claims_the_application_s_own_arithmetic() -> None:
    """Stated as "the way this application computes it" rather than "calculated".

    The rule was observed to hold for every indexed record, which is a much stronger claim than
    arithmetic — and it is the claim the tester is being asked to trust.
    """
    entries = builder()
    entries.derived(
        "amount", 46_200.0, description="the sum of amount across 3 lineItems", confidence=1.0
    )
    entry = entries.entries()[0]

    assert entry.source is ProvenanceSource.DERIVED
    assert entry.explanation == (
        "computed as the sum of amount across 3 lineItems, the way this application computes it"
    )


def test_a_predicate_solved_field_names_the_condition_and_what_it_required() -> None:
    entries = builder()
    entries.predicate_solved(
        "dueAt",
        "2026-07-10T09:00:00Z",
        predicate="overdue",
        requirement="dueAt to be before 2026-08-01T09:00:00Z (now)",
        confidence=0.94,
    )
    entry = entries.entries()[0]

    assert entry.source is ProvenanceSource.PREDICATE_SOLVED
    assert entry.explanation == (
        "set so that 'overdue' holds — it requires dueAt to be before 2026-08-01T09:00:00Z (now)"
    )


def test_a_defaulted_field_says_exactly_why() -> None:
    entries = builder()
    entries.defaulted("terms", "net30", reason="the only value this field has ever held",
                      confidence=0.6)
    entry = entries.entries()[0]

    assert entry.source is ProvenanceSource.DEFAULT
    assert entry.explanation == "the only value this field has ever held"


def test_no_explanation_is_ever_the_word_generated_on_its_own() -> None:
    """The doc's named anti-example. A blanket check, because the failure mode is a new method
    being added with a lazy sentence rather than an existing one regressing."""
    entries = builder()
    entries.requested("a", 1, 0.9)
    entries.requested_within_bounds("b", 2, "over 1", 0.9)
    entries.reference_matched("c", "X-1", entity="E", phrase="x", pool_size=2, confidence=0.9)
    entries.pending_reference("d", entity="E", node_id="e-1")
    entries.sampled("e", SampledValue(1, "drawn from the observed range over 50 records", 0.8))
    entries.sampled_group("f", size=1, requested=False, explanation="the usual", confidence=0.7)
    entries.group_retargeted("g", size=1, total_field="t", total=1, confidence=0.9)
    entries.derived("h", 1, description="the sum of x", confidence=1.0)
    entries.predicate_solved("i", 1, predicate="p", requirement="r", confidence=0.9)

    for entry in entries.entries():
        assert entry.explanation.strip() != "generated"
        assert len(entry.explanation) > 20
