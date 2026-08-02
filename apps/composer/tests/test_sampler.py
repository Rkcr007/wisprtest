"""`ValueSampler` — drawing from this application's observed distributions, never faker defaults.

The property that matters is not "produces a value". It is that every value it produces is one the
application has been seen to hold, because docs/TEST-DATA-ENGINE.md § 3's whole argument for this
module is that a seeded order for £1.00 in an application whose orders run £800–£240,000 passes
creation and then fails three screens later against a rule nobody wrote down.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from support.schemas import order_schema

from composer.protocol.models import FieldSpec, FieldType
from composer.solving.sampler import (
    MAX_UNIQUE_ATTEMPTS,
    UniquenessExhaustedError,
    ValueSampler,
)

NOW = datetime(2026, 8, 1, 9, 0, tzinfo=UTC)


def field(name: str) -> FieldSpec:
    return next(spec for spec in order_schema().fields if spec.name == name)


def sampler(seed: int = 11) -> ValueSampler:
    return ValueSampler(now=NOW, seed=seed)


# ── Determinism ───────────────────────────────────────────────────────────────────────────────


def test_the_same_seed_draws_the_same_value() -> None:
    """Sampling is the only nondeterminism in the composer.

    `CompositionRequest.seed` exists so a test can assert the *same* plan twice; without this
    property every assertion about a composed value is a coin toss.
    """
    spec = field("amount")
    assert sampler(4).sample(spec).value == sampler(4).sample(spec).value


def test_different_seeds_draw_differently() -> None:
    spec = field("lineItems.amount")
    draws = {sampler(seed).sample(spec).value for seed in range(12)}
    assert len(draws) > 1


# ── Staying inside what was observed ──────────────────────────────────────────────────────────


def test_a_numeric_draw_never_leaves_the_observed_range() -> None:
    """Clamped in every branch, including the fitted ones.

    A normal draw two standard deviations out is a perfectly ordinary sample and a completely
    implausible record: the application has never held a value like it, so neither should a
    seeded one.
    """
    spec = field("lineItems.amount")
    shape = spec.distribution.shape if spec.distribution is not None else None
    assert shape is not None

    for seed in range(200):
        drawn = sampler(seed).sample(spec).value
        assert isinstance(drawn, float)
        assert shape.min <= drawn <= shape.max  # type: ignore[union-attr]


def test_an_integer_field_draws_a_whole_number() -> None:
    spec = field("lineItems").model_copy(update={"type": FieldType.INTEGER})
    for seed in range(20):
        assert isinstance(sampler(seed).sample(spec).value, int)


def test_an_enum_draw_only_ever_produces_a_learned_value() -> None:
    spec = field("status")
    allowed = {entry.root for entry in spec.enum_values or []}
    for seed in range(120):
        assert sampler(seed).sample(spec).value in allowed


def test_an_enum_is_sampled_by_observed_frequency() -> None:
    """§ 3: an application whose orders are 4% cancelled should not be seeded 25% cancelled.

    The fixture's `tier` runs bronze 0.50 / silver 0.35 / gold 0.15, which is lopsided enough to
    show up over a few hundred draws without the assertion becoming a coin toss.
    """
    from support.schemas import account_schema

    spec = next(entry for entry in account_schema().fields if entry.name == "tier")
    counts = {"bronze": 0, "silver": 0, "gold": 0}
    for seed in range(600):
        drawn = sampler(seed).sample(spec).value
        assert isinstance(drawn, str)
        counts[drawn] += 1

    assert counts["bronze"] > counts["silver"] > counts["gold"]


def test_a_string_draw_follows_the_learned_prefix_and_charset() -> None:
    spec = field("reference")
    for seed in range(40):
        drawn = sampler(seed).sample(spec, frozenset()).value
        assert isinstance(drawn, str)
        assert drawn.startswith("ORD-")
        assert drawn[4:].isdigit()
        assert len(drawn) == 8


def test_a_temporal_draw_lands_inside_the_observed_offsets() -> None:
    spec = field("dueAt")
    for seed in range(60):
        drawn = sampler(seed).sample(spec).value
        assert isinstance(drawn, str)
        offset_days = (datetime.fromisoformat(drawn.replace("Z", "+00:00")) - NOW).days
        assert -148 <= offset_days <= 0


# ── Uniqueness ────────────────────────────────────────────────────────────────────────────────


def test_a_unique_field_avoids_values_that_already_exist() -> None:
    spec = field("reference")
    taken = frozenset({sampler(3).sample(spec).value})
    assert sampler(3).sample(spec, taken).value not in taken


def test_uniqueness_gives_up_rather_than_spinning() -> None:
    """§ 3 requires the collision check; the bound is what stops it being an infinite loop.

    A field whose whole observed vocabulary is already taken cannot produce a fresh value, and
    saying so is more use than looping — the caller turns it into a refusal the tester can act on.
    """
    spec = field("status").model_copy(update={"unique": True})
    everything = frozenset({entry.root for entry in spec.enum_values or []})

    with pytest.raises(UniquenessExhaustedError) as caught:
        sampler().sample(spec, everything)

    assert caught.value.field == "status"
    assert caught.value.attempts == MAX_UNIQUE_ATTEMPTS


def test_a_non_unique_field_is_allowed_to_repeat() -> None:
    # Two orders may perfectly well be for the same amount; `taken` is not a filter for everything.
    spec = field("amount")
    assert sampler(5).sample(spec, frozenset({sampler(5).sample(spec).value})).value is not None


# ── No evidence at all ────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("type_", "check"),
    [
        (FieldType.INTEGER, lambda value: isinstance(value, int)),
        (FieldType.NUMBER, lambda value: isinstance(value, float)),
        (FieldType.BOOLEAN, lambda value: isinstance(value, bool)),
        (FieldType.DATETIME, lambda value: isinstance(value, str)),
        (FieldType.GROUP, lambda value: value == []),
        (FieldType.STRING, lambda value: isinstance(value, str)),
    ],
)
def test_a_field_the_indexer_learned_nothing_about_still_gets_a_value(
    type_: FieldType, check: object
) -> None:
    """Deliberately still a value, and deliberately low confidence.

    Refusing the whole composition because one optional field has no distribution would make the
    engine unusable on any application that was not exhaustively indexed. The provenance says
    plainly that this one is a guess, and the preview shows the tester that before anything is
    created.
    """
    spec = field("terms").model_copy(
        update={"type": type_, "distribution": None, "enum_values": None}
    )
    drawn = sampler().sample(spec)

    assert callable(check) and check(drawn.value)
    assert drawn.confidence < 0.5
    assert "no distribution was learned" in drawn.explanation


# ── Bounded draws, for a spoken comparison ────────────────────────────────────────────────────


def test_sample_within_stays_inside_the_overlap_with_the_observed_range() -> None:
    spec = field("lineItems.amount")
    for seed in range(50):
        drawn = sampler(seed).sample_within(spec, 500.0, 900.0)
        assert isinstance(drawn.value, float)
        assert 500.0 <= drawn.value <= 900.0


def test_sample_within_follows_the_tester_outside_the_observed_range_and_says_so() -> None:
    """§ 7's rule applied to a bound rather than to a value.

    A tester who asks for an amount larger than anything the indexer saw is asking for exactly
    that. Quietly capping them at the observed maximum would be the silent narrowing the doc
    forbids, so the draw leaves the range and the explanation and confidence both admit it.
    """
    spec = field("lineItems.amount")
    drawn = sampler().sample_within(spec, 90_000.0, 100_000.0)

    assert isinstance(drawn.value, float)
    assert 90_000.0 <= drawn.value <= 100_000.0
    assert "outside everything this application has been seen to hold" in drawn.explanation
    assert drawn.confidence < 0.85


def test_sample_within_on_a_field_with_no_learned_shape_uses_only_the_bound() -> None:
    spec = field("terms").model_copy(
        update={"type": FieldType.NUMBER, "distribution": None, "enum_values": None}
    )
    drawn = sampler().sample_within(spec, 10.0, 20.0)

    assert isinstance(drawn.value, float)
    assert 10.0 <= drawn.value <= 20.0
    assert "no distribution was learned" in drawn.explanation


def test_choose_is_seeded_so_a_pick_is_reproducible() -> None:
    options = ["a", "b", "c", "d", "e"]
    assert sampler(9).choose(options) == sampler(9).choose(options)
