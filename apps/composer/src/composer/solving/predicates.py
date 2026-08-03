"""Making a named condition true, rather than checking whether it happens to be.

docs/TEST-DATA-ENGINE.md § 3 calls predicates "the interesting case", and the interesting part is
the direction of travel. `overdue` is not a field the tester can set; it is a condition the
application *derives* — `due_date < now() AND status != 'Paid'` — and a tester who asks for an
overdue invoice is asking the engine to work backwards from the condition to values that produce
it. Sampling `due_date` from the observed range and hoping it lands in the past is not seeding, it
is rolling dice on the tester's behalf.

## Working in offsets, not instants

Every temporal clause is solved as an offset in days from the request's `now`, and only converted
to a timestamp at the end. That is what lets the observed distribution ("this application's
invoices fall between 147 days ago and yesterday") and the clause ("before now") be intersected
at all: they are statements about the same axis, and one is expressed relative to the clock in the
contract precisely so it stays true as the clock moves.

## The margin

A clause is never satisfied exactly on its boundary. A due date set to *this instant* satisfies
`due_date < now()` when the plan is composed and fails it a second later when the record is
actually created — the preview would have promised an overdue invoice and the application would
hold a current one. `MARGIN_DAYS` is the slack that makes the predicate survive the gap between
composing and materializing, which § 6 says is however long the tester takes to read the preview.

## Leaving the observed range is allowed, and is said out loud

Where a predicate cannot be satisfied anywhere inside what the indexer observed — every invoice it
saw was already paid, and the tester wants an unpaid one — the clause still wins, because the
tester asked for the condition and not for a typical record. The solution records that it left the
observed range so the provenance can say so, and the confidence it carries drops accordingly.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from composer.protocol.models import (
    DistributionNumeric,
    DistributionTemporal,
    FieldSpec,
    FieldType,
    Op1,
    PredicateClause,
    PredicateOperandLiteral,
    PredicateOperandNow,
)
from composer.solving.sampler import ValueSampler

#: Slack, in days, by which a temporal clause is over-satisfied. See the module docstring.
MARGIN_DAYS = 1.0

#: How many redraws a `neq` clause gets before the sampler is judged unable to avoid the value.
MAX_AVOIDANCE_ATTEMPTS = 16

_UPPER = (Op1.LT, Op1.LTE)

_TEMPORAL_TYPES = (FieldType.DATE, FieldType.DATETIME)
_NUMERIC_TYPES = (FieldType.INTEGER, FieldType.NUMBER, FieldType.CURRENCY)


@dataclass(frozen=True)
class ClauseSolution:
    """A value that makes one clause true, and the sentence explaining what it had to satisfy."""

    field: str
    value: object
    #: The clause in words, e.g. "dueAt to be before 2026-08-02T09:00:00Z". Rendered to the tester.
    requirement: str
    #: True when no value inside the observed distribution could satisfy the clause.
    outside_observed_range: bool = False


@dataclass(frozen=True)
class ClauseUnsatisfiable:
    """No value of this field can make the clause true, and the concrete reason why."""

    field: str
    requirement: str
    reason: str


ClauseOutcome = ClauseSolution | ClauseUnsatisfiable


# ── Reading a clause ──────────────────────────────────────────────────────────────────────────

_WORDS: dict[Op1, str] = {
    Op1.EQ: "to be",
    Op1.NEQ: "to be anything other than",
    Op1.LT: "to be before",
    Op1.LTE: "to be no later than",
    Op1.GT: "to be after",
    Op1.GTE: "to be no earlier than",
}

_NUMERIC_WORDS: dict[Op1, str] = {
    Op1.EQ: "to be",
    Op1.NEQ: "to be anything other than",
    Op1.LT: "to be under",
    Op1.LTE: "to be at most",
    Op1.GT: "to be over",
    Op1.GTE: "to be at least",
}


def describe(clause: PredicateClause, now: datetime) -> str:
    """The clause as a sentence a tester reads, with `now()` resolved to the instant it means."""
    if isinstance(clause.operand, PredicateOperandNow):
        moment = _shift(now, clause.operand.offset_days)
        rendered = _iso(moment)
        if clause.operand.offset_days:
            direction = "after" if clause.operand.offset_days > 0 else "before"
            rendered += f" ({abs(clause.operand.offset_days):g} days {direction} now)"
        else:
            rendered += " (now)"
        return f"{clause.field} {_WORDS[clause.op]} {rendered}"

    words = _NUMERIC_WORDS if isinstance(clause.operand.value, int | float) else _WORDS
    return f"{clause.field} {words[clause.op]} {clause.operand.value!r}"


def holds(clause: PredicateClause, value: object, now: datetime) -> bool:
    """Whether `value` satisfies the clause. Used to verify a solved record before returning it."""
    if isinstance(clause.operand, PredicateOperandNow):
        moment = _as_moment(value)
        if moment is None:
            return False
        return _compare(
            moment.timestamp(), _shift(now, clause.operand.offset_days).timestamp(), clause.op
        )

    literal = clause.operand.value
    if clause.op is Op1.EQ:
        return bool(value == literal)
    if clause.op is Op1.NEQ:
        return bool(value != literal)

    left, right = _as_number(value), _as_number(literal)
    if left is not None and right is not None:
        return _compare(left, right, clause.op)

    left_moment, right_moment = _as_moment(value), _as_moment(literal)
    if left_moment is not None and right_moment is not None:
        return _compare(left_moment.timestamp(), right_moment.timestamp(), clause.op)

    # An ordering comparison between two things that are neither numbers nor timestamps has no
    # meaning. Reported as not holding rather than raising: the caller turns it into a conflict
    # naming the clause, which is more use to a tester than a stack trace.
    return False


# ── Solving a clause ──────────────────────────────────────────────────────────────────────────


def solve(
    clause: PredicateClause,
    spec: FieldSpec,
    *,
    now: datetime,
    current: object,
    sampler: ValueSampler,
) -> ClauseOutcome:
    """A value for `spec` that makes `clause` true, starting from whatever the field holds.

    `current` is honoured wherever it already satisfies the clause: a status the tester asked for
    explicitly, or one the sampler drew that happens to be fine, should not be replaced just
    because a predicate mentions the field. Replacing it would be the silent drop § 7 forbids,
    pointed at the tester's own words.
    """
    requirement = describe(clause, now)
    if holds(clause, current, now) and current is not None:
        return ClauseSolution(field=spec.name, value=current, requirement=requirement)

    if isinstance(clause.operand, PredicateOperandNow):
        return _solve_temporal(clause, clause.operand, spec, now, current, requirement)

    return _solve_literal(clause, clause.operand, spec, now, current, sampler, requirement)


def _solve_temporal(
    clause: PredicateClause,
    operand: PredicateOperandNow,
    spec: FieldSpec,
    now: datetime,
    current: object,
    requirement: str,
) -> ClauseOutcome:
    if spec.type not in _TEMPORAL_TYPES:
        return ClauseUnsatisfiable(
            field=spec.name,
            requirement=requirement,
            reason=(
                f"{spec.name} is a {spec.type.value} field, and the condition compares it against "
                "a point in time"
            ),
        )

    bound = operand.offset_days
    if clause.op is Op1.EQ:
        return ClauseSolution(
            field=spec.name, value=_iso(_shift(now, bound)), requirement=requirement
        )
    if clause.op is Op1.NEQ:
        return ClauseSolution(
            field=spec.name,
            value=_iso(_shift(now, bound + MARGIN_DAYS)),
            requirement=requirement,
        )

    observed = _observed_offsets(spec)
    starting = _as_moment(current)
    start_offset = (starting - now).total_seconds() / 86_400 if starting is not None else None

    target, outside = _project(start_offset, bound, clause.op, observed, MARGIN_DAYS)
    return ClauseSolution(
        field=spec.name,
        value=_iso(_shift(now, target)),
        requirement=requirement,
        outside_observed_range=outside,
    )


def _solve_literal(
    clause: PredicateClause,
    operand: PredicateOperandLiteral,
    spec: FieldSpec,
    now: datetime,
    current: object,
    sampler: ValueSampler,
    requirement: str,
) -> ClauseOutcome:
    literal = operand.value

    if clause.op is Op1.EQ:
        return ClauseSolution(field=spec.name, value=literal, requirement=requirement)

    if clause.op is Op1.NEQ:
        return _avoid(spec, literal, sampler, requirement)

    bound = _as_number(literal)
    if bound is not None and spec.type in _NUMERIC_TYPES:
        observed = _observed_numeric(spec)
        start = _as_number(current)
        step = 1.0 if spec.type is FieldType.INTEGER else max(abs(bound) * 0.01, 0.01)
        target, outside = _project(start, bound, clause.op, observed, step)
        value = round(target) if spec.type is FieldType.INTEGER else round(target, 2)
        return ClauseSolution(
            field=spec.name, value=value, requirement=requirement, outside_observed_range=outside
        )

    moment = _as_moment(literal)
    if moment is not None and spec.type in _TEMPORAL_TYPES:
        offset = (moment - now).total_seconds() / 86_400
        starting = _as_moment(current)
        start_offset = (starting - now).total_seconds() / 86_400 if starting is not None else None
        target, outside = _project(
            start_offset, offset, clause.op, _observed_offsets(spec), MARGIN_DAYS
        )
        return ClauseSolution(
            field=spec.name,
            value=_iso(_shift(now, target)),
            requirement=requirement,
            outside_observed_range=outside,
        )

    return ClauseUnsatisfiable(
        field=spec.name,
        requirement=requirement,
        reason=(
            f"{spec.name} is a {spec.type.value} field and the condition orders it against "
            f"{literal!r}, which is neither a number nor a timestamp"
        ),
    )


def _avoid(
    spec: FieldSpec, literal: object, sampler: ValueSampler, requirement: str
) -> ClauseOutcome:
    """Redraw until the sampler produces something other than `literal`.

    Bounded, and the bound is what makes the unsatisfiable case reportable: a field whose learned
    vocabulary holds exactly the one value the condition forbids cannot satisfy it, and saying so
    is more use than sampling forever.
    """
    if spec.enum_values is not None:
        allowed = [entry.root for entry in spec.enum_values if entry.root != literal]
        if not allowed:
            return ClauseUnsatisfiable(
                field=spec.name,
                requirement=requirement,
                reason=(
                    f"{spec.name} only ever holds {literal!r} in this application, and the "
                    "condition requires something else"
                ),
            )

    for _attempt in range(MAX_AVOIDANCE_ATTEMPTS):
        drawn = sampler.sample(spec)
        if drawn.value != literal:
            return ClauseSolution(field=spec.name, value=drawn.value, requirement=requirement)

    return ClauseUnsatisfiable(
        field=spec.name,
        requirement=requirement,
        reason=(
            f"every value drawn for {spec.name} was {literal!r}, which the condition forbids; "
            f"the observed distribution offers nothing else in {MAX_AVOIDANCE_ATTEMPTS} draws"
        ),
    )


# ── Shared numeric work ───────────────────────────────────────────────────────────────────────


def _project(
    start: float | None,
    bound: float,
    op: Op1,
    observed: tuple[float, float] | None,
    margin: float,
) -> tuple[float, bool]:
    """Move `start` to the nearest point that satisfies `op bound`, preferring observed values.

    Returns the point and whether reaching it meant leaving the observed range. The preference
    order is the whole of § 3's sampling doctrine in three lines: stay where the application's own
    data lives if the condition allows it, move to the edge of that range if it does not, and only
    step outside when nothing inside can be true.
    """
    limit = bound - margin if op in _UPPER else bound + margin

    if observed is None:
        return (limit if start is None else _clamp_to(start, limit, op)), False

    low, high = observed
    if op in _UPPER:
        ceiling = min(high, limit)
        if ceiling < low:
            return limit, True
        return (ceiling if start is None else min(max(start, low), ceiling)), False

    floor = max(low, limit)
    if floor > high:
        return limit, True
    return (floor if start is None else max(min(start, high), floor)), False


def _clamp_to(start: float, limit: float, op: Op1) -> float:
    return min(start, limit) if op in _UPPER else max(start, limit)


def _observed_offsets(spec: FieldSpec) -> tuple[float, float] | None:
    distribution = spec.distribution
    if distribution is None or not isinstance(distribution.shape, DistributionTemporal):
        return None
    return (distribution.shape.min_offset_days, distribution.shape.max_offset_days)


def _observed_numeric(spec: FieldSpec) -> tuple[float, float] | None:
    distribution = spec.distribution
    if distribution is None or not isinstance(distribution.shape, DistributionNumeric):
        return None
    return (distribution.shape.min, distribution.shape.max)


def _compare(left: float, right: float, op: Op1) -> bool:
    if op is Op1.LT:
        return left < right
    if op is Op1.LTE:
        return left <= right
    if op is Op1.GT:
        return left > right
    if op is Op1.GTE:
        return left >= right
    if op is Op1.EQ:
        return left == right
    return left != right


def _as_number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def _as_moment(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _shift(now: datetime, offset_days: float) -> datetime:
    return now + timedelta(days=offset_days)


def _iso(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")
