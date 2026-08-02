"""Drawing plausible values from an application's own observed distributions.

docs/TEST-DATA-ENGINE.md § 3 is unambiguous about why this module exists:

    Never `faker` defaults. Sample from **this application's** observed distribution so seeded
    data is indistinguishable from real data and does not break downstream validation.

A seeded order for £1.00 in an application whose orders run £800 to £240,000 is not a test fixture.
It passes creation and then fails three screens later against a validation rule nobody wrote
down, and the tester spends an afternoon deciding whether they found a bug. Every value this
module returns is drawn from a shape the indexer observed in real records, so the record it
composes is one the application would have produced itself.

## Determinism

Sampling is the only nondeterminism in the composer, which makes it the only thing standing
between the test suite and assertions that are coin tosses. Every sampler owns a `random.Random`
seeded from the request, so the same request composes the same record twice — and a property
test can shrink a failure to a seed rather than to "it happened once".

## Uniqueness

§ 3 requires a collision check "against observed values before returning". Retries are bounded:
an unbounded resample against a field whose observed range is smaller than the number of records
already in the application is an infinite loop, so the sampler gives up and says so rather than
spinning.
"""

from __future__ import annotations

import math
import random
import string
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TypeVar

from composer.protocol.models import (
    DistributionCategorical,
    DistributionNumeric,
    DistributionStringPattern,
    DistributionTemporal,
    FieldSpec,
    FieldType,
)

T = TypeVar("T")

#: How many times a unique field may be resampled before the sampler admits defeat.
MAX_UNIQUE_ATTEMPTS = 24

#: Fallback length for a string field whose observed shape says nothing about length.
DEFAULT_STRING_LENGTH = 8

_CHARSETS: dict[str, str] = {
    "numeric": string.digits,
    "alpha": string.ascii_uppercase,
    "alphanumeric": string.ascii_uppercase + string.digits,
    "mixed": string.ascii_uppercase + string.digits,
}


class UniquenessExhaustedError(Exception):
    """A unique field could not be given a value that was not already taken.

    Surfaced rather than swallowed: returning a colliding value would produce a record the
    application rejects, and returning nothing would produce one that fails validation. Neither
    is better than saying the observed value space is too small.
    """

    def __init__(self, field: str, attempts: int) -> None:
        super().__init__(
            f"could not find an unused value for {field!r} in {attempts} attempts; "
            "the observed value space may be smaller than the data already in the application"
        )
        self.field: str = field
        self.attempts: int = attempts


@dataclass(frozen=True)
class SampledValue:
    """A drawn value and the one-line account of where it came from.

    The explanation is built here rather than in `provenance.py` because this is the only place
    that knows *which* shape was drawn from and how much evidence stood behind it. § 3 requires
    provenance to be specific — "matched from 64 known accounts", not "generated" — and a
    builder one layer up could only say "sampled".
    """

    value: object
    explanation: str
    confidence: float


class ValueSampler:
    """Draws field values from learned distributions. One per composition request."""

    def __init__(self, *, now: datetime, seed: int | None = None) -> None:
        # Not a security primitive: this draws plausible order amounts, and reproducibility
        # under a seed is the property that matters. `secrets` would make the test suite
        # non-deterministic in exchange for entropy nothing here needs.
        self._random = random.Random(seed)  # noqa: S311
        self._now = now

    # ── The entry point ───────────────────────────────────────────────────────────────────

    def sample(self, field: FieldSpec, taken: frozenset[object] = frozenset()) -> SampledValue:
        """Draw one plausible value for `field`, avoiding anything in `taken`.

        `taken` matters only for fields the indexer marked unique. For everything else a repeat
        is not a collision — two orders may perfectly well be for the same amount.
        """
        if not field.unique:
            return self._draw(field)

        for _attempt in range(MAX_UNIQUE_ATTEMPTS):
            candidate = self._draw(field)
            if candidate.value not in taken:
                return candidate

        raise UniquenessExhaustedError(field.name, MAX_UNIQUE_ATTEMPTS)

    def sample_within(self, field: FieldSpec, low: float, high: float) -> SampledValue:
        """Draw a numeric value inside `[low, high]`, preferring the observed range.

        This is what a spoken bound — "an order over £50,000" — turns into. The interval the caller
        passes is what the tester's words allow; the observed distribution is what the application
        has actually been seen to hold, and where the two overlap the draw comes from the overlap.

        Where they do not overlap the tester wins, and the explanation says so. § 3's sampling
        doctrine exists to make seeded data indistinguishable from real data, but a tester who asks
        for an amount larger than anything the indexer saw is asking for exactly that, and quietly
        capping them at the observed maximum would be the silent narrowing § 7 forbids.
        """
        shape = field.distribution.shape if field.distribution is not None else None
        observed = shape if isinstance(shape, DistributionNumeric) else None

        inside = observed is not None and observed.min <= high and observed.max >= low
        if observed is not None and inside:
            floor, ceiling = max(low, observed.min), min(high, observed.max)
            drawn = min(max(self._numeric_in_range(observed), floor), ceiling)
            note = f"inside the observed range {observed.min:g} to {observed.max:g}"
        else:
            floor, ceiling = low, high
            drawn = self._random.uniform(floor, ceiling)
            note = (
                "outside everything this application has been seen to hold, because that is what "
                "was asked for"
                if observed is not None
                else "no distribution was learned for this field, so only your bound shaped it"
            )

        value: float | int = (
            round(min(max(drawn, floor), ceiling))
            if field.type is FieldType.INTEGER
            else round(min(max(drawn, floor), ceiling), 2)
        )
        return SampledValue(value, note, 0.85 if inside else 0.6)

    def choose(self, options: Sequence[T]) -> T:
        """Pick one of `options` under the request's seed.

        Exposed rather than letting callers reach for `random` directly: the seed on the request
        exists so a composition is reproducible, and a second unseeded generator anywhere in the
        solver would quietly break that for whichever field used it.
        """
        return self._random.choice(options)

    # ── Per-shape draws ───────────────────────────────────────────────────────────────────

    def _draw(self, field: FieldSpec) -> SampledValue:
        # An enum vocabulary is checked before the distribution, because a categorical
        # distribution carries frequencies and the vocabulary carries the legal set. Sampling by
        # frequency is what makes seeded data blend in: an application whose orders are 4%
        # cancelled should not receive a test set that is 25% cancelled.
        if field.enum_values:
            return self._draw_enum(field)

        distribution = field.distribution
        if distribution is None:
            return self._draw_without_evidence(field)

        shape = distribution.shape
        sample_size = distribution.sample_size

        if isinstance(shape, DistributionNumeric):
            return self._draw_numeric(field, shape, sample_size)
        if isinstance(shape, DistributionCategorical):
            return self._draw_categorical(shape, sample_size)
        if isinstance(shape, DistributionStringPattern):
            return self._draw_string(shape, sample_size)
        # The four `DistributionShape` variants are a closed union in the contract, so the
        # remaining case is temporal. Written as a bare return rather than a fourth `isinstance`
        # so that adding a fifth variant to the contract fails this file at typecheck time
        # instead of silently falling through to a guess.
        return self._draw_temporal(shape, sample_size)

    def _draw_enum(self, field: FieldSpec) -> SampledValue:
        # `enum_values` arrives as root models: a `NonEmptyString` inside a list cannot carry its
        # constraint on the field, so the generator wraps each element. `.root` is the string.
        values = [entry.root for entry in field.enum_values or []]
        distribution = field.distribution
        shape = distribution.shape if distribution is not None else None

        if isinstance(shape, DistributionCategorical):
            # Weighted by what the application actually contains.
            weights = [max(shape.frequencies.get(value, 0.0), 0.0) for value in values]
            if sum(weights) > 0:
                choice = self._random.choices(values, weights=weights, k=1)[0]
                share = shape.frequencies.get(choice, 0.0)
                return SampledValue(
                    choice,
                    f"sampled from the learned vocabulary by observed frequency "
                    f"({share:.0%} of {distribution.sample_size if distribution else 0} records)",
                    0.9,
                )

        choice = self._random.choice(values)
        return SampledValue(
            choice,
            f"chosen from the {len(values)} values this field accepts",
            0.75,
        )

    def _draw_numeric(
        self, field: FieldSpec, shape: DistributionNumeric, sample_size: int
    ) -> SampledValue:
        value = self._numeric_in_range(shape)

        if field.type == FieldType.INTEGER:
            drawn: float | int = round(value)
        else:
            drawn = round(value, 2)

        return SampledValue(
            drawn,
            f"drawn from the observed {shape.fit.value} distribution over {sample_size} records "
            f"(range {shape.min:g} to {shape.max:g})",
            0.85,
        )

    def _numeric_in_range(self, shape: DistributionNumeric) -> float:
        """Draw inside the observed range, following the fitted family where there is one.

        Clamped to the observed range in every branch. A normal draw two standard deviations out
        is a perfectly ordinary sample and a completely implausible record — the application has
        never held a value like it, so neither should a seeded one.
        """
        low, high = shape.min, shape.max
        if low >= high:
            return low

        if shape.fit.value == "lognormal" and low > 0:
            # Fit in log space, where a right-skewed range is symmetric.
            log_mean = math.log(max(shape.mean, 1e-9))
            log_sigma = max(math.log1p(shape.stddev / max(shape.mean, 1e-9)), 1e-6)
            drawn = math.exp(self._random.gauss(log_mean, log_sigma))
        elif shape.fit.value == "normal" and shape.stddev > 0:
            drawn = self._random.gauss(shape.mean, shape.stddev)
        else:
            # `uniform` and `unknown` share a branch on purpose. When the indexer could not name
            # a family, drawing uniformly inside the observed range is the honest fallback: every
            # value it can produce is one the application has been seen to hold.
            drawn = self._random.uniform(low, high)

        return min(max(drawn, low), high)

    def _draw_categorical(self, shape: DistributionCategorical, sample_size: int) -> SampledValue:
        values = list(shape.frequencies)
        weights = [max(shape.frequencies[value], 0.0) for value in values]
        if not values or sum(weights) <= 0:
            return SampledValue("", "no observed values to draw from", 0.2)

        choice = self._random.choices(values, weights=weights, k=1)[0]
        return SampledValue(
            choice,
            f"sampled by observed frequency across {sample_size} records "
            f"({shape.frequencies[choice]:.0%} of them)",
            0.85,
        )

    def _draw_string(self, shape: DistributionStringPattern, sample_size: int) -> SampledValue:
        prefix = shape.prefix or ""
        alphabet = _CHARSETS.get(shape.charset.value, string.ascii_uppercase + string.digits)

        # The learned lengths cover the whole value; the body is what is left after the prefix.
        low = max(shape.min_length - len(prefix), 1)
        high = max(shape.max_length - len(prefix), low)
        body_length = self._random.randint(low, high)
        body = "".join(self._random.choice(alphabet) for _ in range(body_length))

        described = (
            f"the learned shape ({prefix!r} + {shape.charset.value})"
            if prefix
            else (f"the learned {shape.charset.value} shape")
        )
        return SampledValue(
            f"{prefix}{body}",
            f"generated to match {described} of {sample_size} observed values",
            0.8,
        )

    def _draw_temporal(self, shape: DistributionTemporal, sample_size: int) -> SampledValue:
        offset = self._random.uniform(shape.min_offset_days, shape.max_offset_days)
        moment = self._now + timedelta(days=offset)
        return SampledValue(
            moment.isoformat().replace("+00:00", "Z"),
            f"placed {abs(offset):.0f} days "
            f"{'ago' if offset < 0 else 'ahead'}, inside the range observed across "
            f"{sample_size} records",
            0.8,
        )

    def _draw_without_evidence(self, field: FieldSpec) -> SampledValue:
        """A field the indexer learned nothing about.

        Deliberately low confidence, and deliberately still a value. The alternative — refusing
        the whole composition because one optional field has no distribution — would make the
        engine unusable on any application that was not exhaustively indexed. The provenance
        says plainly that this one is a guess, and the preview shows the tester that before
        anything is created.
        """
        constraints = field.value_constraints
        if field.type in (FieldType.INTEGER, FieldType.NUMBER, FieldType.CURRENCY):
            low = constraints.min if constraints.min is not None else 1.0
            high = constraints.max if constraints.max is not None else low + 100.0
            drawn = self._random.uniform(low, high)
            value: object = round(drawn) if field.type == FieldType.INTEGER else round(drawn, 2)
        elif field.type == FieldType.BOOLEAN:
            value = self._random.choice([True, False])
        elif field.type in (FieldType.DATE, FieldType.DATETIME):
            value = self._now.isoformat().replace("+00:00", "Z")
        elif field.type == FieldType.GROUP:
            value = []
        else:
            length = constraints.min_length or DEFAULT_STRING_LENGTH
            capped = min(length, constraints.max_length or DEFAULT_STRING_LENGTH)
            value = "".join(
                self._random.choice(string.ascii_uppercase) for _ in range(max(capped, 1))
            )

        return SampledValue(
            value,
            "no distribution was learned for this field, so the value only satisfies "
            "the validation the form declares",
            0.3,
        )
