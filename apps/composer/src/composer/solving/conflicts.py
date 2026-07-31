"""Detecting requirements that cannot both hold, and saying so in words.

docs/TEST-DATA-ENGINE.md § 7 gives this its whole specification:

    Unsatisfiable constraints → report the conflict in plain language; never silently drop a
    constraint.

Dropping one is the tempting implementation and by far the worst. The tester gets a record, has
no reason to doubt it satisfies what they asked for, and tests something other than what they
meant to. A refusal costs them ten seconds; a silently-narrowed constraint costs them the trust
they had in every record the engine ever made.

The checks below are the ones that can be decided *before* any value is drawn — a contradiction
between two things the tester said, or between something they said and something the schema
forbids. Contradictions that only appear once values exist (a derived rule that cannot reach a
requested total) are found by the solver as it works, and reported through the same type.
"""

from __future__ import annotations

from composer.protocol.models import (
    ConflictSideConstraint,
    ConflictSideSchema,
    ConstraintComparison,
    ConstraintConflict,
    ConstraintEquals,
    ConstraintPredicate,
    EntitySchema,
    FieldSpec,
    Op,
)
from composer.solving.types import Constraint

_LOWER_BOUNDS = (Op.GT, Op.GTE)
_UPPER_BOUNDS = (Op.LT, Op.LTE)


def _describe(value: float) -> str:
    """Format a number the way it would be spoken, not the way it is stored."""
    if value == int(value):
        return f"{int(value):,}"
    return f"{value:,.2f}"


def find_conflict(schema: EntitySchema, constraints: list[Constraint]) -> ConstraintConflict | None:
    """The first contradiction in `constraints`, or `None` if they can all hold.

    First rather than all, deliberately: a tester fixes one thing at a time, and a list of six
    conflicts — most of them consequences of the first — is harder to act on than the one that
    matters. The next composition finds the next one.
    """
    fields = {spec.name: spec for spec in schema.fields}

    return (
        _contradictory_bounds(constraints)
        or _value_outside_bounds(constraints)
        or _value_outside_vocabulary(fields, constraints)
        or _predicate_against_value(schema, constraints)
    )


def _contradictory_bounds(constraints: list[Constraint]) -> ConstraintConflict | None:
    """ "over £50,000 and under £1,000" — two comparisons with no number between them."""
    comparisons = [entry for entry in constraints if isinstance(entry, ConstraintComparison)]

    for lower in comparisons:
        if lower.op not in _LOWER_BOUNDS:
            continue
        for upper in comparisons:
            if upper.op not in _UPPER_BOUNDS or upper.field != lower.field:
                continue
            if lower.value < upper.value:
                continue
            # Equal bounds are only a conflict when at least one is strict: `>= 5 and <= 5`
            # is satisfiable by exactly 5.
            if lower.value == upper.value and lower.op == Op.GTE and upper.op == Op.LTE:
                continue

            return ConstraintConflict(
                left=ConflictSideConstraint(kind="constraint", constraint=lower),
                right=ConflictSideConstraint(kind="constraint", constraint=upper),
                field=lower.field,
                explanation=(
                    f"{lower.field} cannot be both {_phrase(lower)} and {_phrase(upper)} — "
                    "no value satisfies both"
                ),
            )
    return None


def _value_outside_bounds(constraints: list[Constraint]) -> ConstraintConflict | None:
    """An explicit value that its own comparison rules out."""
    comparisons = [entry for entry in constraints if isinstance(entry, ConstraintComparison)]

    for equals in (entry for entry in constraints if isinstance(entry, ConstraintEquals)):
        if not isinstance(equals.value, int | float) or isinstance(equals.value, bool):
            continue
        for comparison in comparisons:
            if comparison.field != equals.field or _satisfies(float(equals.value), comparison):
                continue

            return ConstraintConflict(
                left=ConflictSideConstraint(kind="constraint", constraint=equals),
                right=ConflictSideConstraint(kind="constraint", constraint=comparison),
                field=equals.field,
                explanation=(
                    f"{equals.field} was asked for as {_describe(float(equals.value))}, "
                    f"which is not {_phrase(comparison)}"
                ),
            )
    return None


def _value_outside_vocabulary(
    fields: dict[str, FieldSpec], constraints: list[Constraint]
) -> ConstraintConflict | None:
    """A value the field's learned vocabulary does not contain.

    The conflict names the vocabulary, because "escalated is not a valid status" is only half an
    answer — the tester needs to know what *is* valid, and the learned set is exactly that.
    """
    for equals in (entry for entry in constraints if isinstance(entry, ConstraintEquals)):
        spec = fields.get(equals.field)
        if spec is None or not spec.enum_values:
            continue

        allowed = [entry.root for entry in spec.enum_values]
        if isinstance(equals.value, str) and equals.value in allowed:
            continue

        return ConstraintConflict(
            left=ConflictSideConstraint(kind="constraint", constraint=equals),
            right=ConflictSideSchema(
                kind="schema",
                field=equals.field,
                detail=f"accepts only {', '.join(allowed)}",
            ),
            field=equals.field,
            explanation=(
                f"{equals.field} was asked for as {equals.value!r}, but this application only "
                f"uses {', '.join(allowed)}"
            ),
        )
    return None


def _predicate_against_value(
    schema: EntitySchema, constraints: list[Constraint]
) -> ConstraintConflict | None:
    """A named condition that contradicts a value said in the same breath.

    "a shipped order that is overdue", where `overdue` was learned as `status != shipped`. Both
    halves are individually reasonable, which is what makes this worth checking: the solver
    would otherwise satisfy whichever it applied last and produce a record that quietly fails
    the predicate the tester actually cared about.
    """
    equals_by_field = {
        entry.field: entry for entry in constraints if isinstance(entry, ConstraintEquals)
    }
    predicates = {definition.name: definition for definition in schema.predicates}

    for requested in (entry for entry in constraints if isinstance(entry, ConstraintPredicate)):
        definition = predicates.get(requested.name)
        if definition is None:
            continue

        for clause in definition.clauses:
            stated = equals_by_field.get(clause.field)
            if stated is None or clause.operand.kind != "literal":
                continue

            literal = clause.operand.value
            contradicts = (clause.op.value == "neq" and stated.value == literal) or (
                clause.op.value == "eq" and stated.value != literal
            )
            if not contradicts:
                continue

            requirement = (
                f"{clause.field} is not {literal!r}"
                if clause.op.value == "neq"
                else f"{clause.field} is {literal!r}"
            )
            return ConstraintConflict(
                left=ConflictSideConstraint(kind="constraint", constraint=requested),
                right=ConflictSideConstraint(kind="constraint", constraint=stated),
                field=clause.field,
                explanation=(
                    f"{requested.name!r} requires that {requirement}, but {stated.field} was "
                    f"asked for as {stated.value!r}"
                ),
            )
    return None


def _phrase(comparison: ConstraintComparison) -> str:
    """A comparison as a tester would say it, for the explanation."""
    words = {Op.GT: "over", Op.GTE: "at least", Op.LT: "under", Op.LTE: "at most"}
    return f"{words[comparison.op]} {_describe(comparison.value)}"


def _satisfies(value: float, comparison: ConstraintComparison) -> bool:
    if comparison.op == Op.GT:
        return value > comparison.value
    if comparison.op == Op.GTE:
        return value >= comparison.value
    if comparison.op == Op.LT:
        return value < comparison.value
    return value <= comparison.value
