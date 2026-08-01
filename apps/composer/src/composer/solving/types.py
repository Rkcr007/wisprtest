"""Shared aliases for the solver.

`Constraint` is spelled out rather than imported from the generated models because the contract
inlines discriminated unions at their use sites (see `apps/composer/tests/test_protocol_models.py`
for why): there is no `Constraint` class to import, only the five members. Naming the union once
here keeps every solver signature readable and makes adding a sixth member a single edit.
"""

from __future__ import annotations

from composer.protocol.models import (
    ConstraintCardinality,
    ConstraintComparison,
    ConstraintEquals,
    ConstraintPredicate,
    ConstraintReference,
)

Constraint = (
    ConstraintEquals
    | ConstraintReference
    | ConstraintCardinality
    | ConstraintComparison
    | ConstraintPredicate
)
