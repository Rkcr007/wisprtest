"""Evaluating the derived-field rules the indexer learned.

docs/TEST-DATA-ENGINE.md § 3 puts this last in the solve order — "evaluate derived rules last
(amount = Σ lines = $46,200)" — and the ordering is the whole design. A derived field is not a
value to be sampled and then checked; it is a value the application computes, and the only way a
composed record survives contact with real validation is for the engine to compute it the same
way from the values that were finally chosen. Sampling `amount` and then filling `lines` would
produce a record whose total does not match its own line items.

The six rules here are exactly the ones `DerivedRuleSpec` allows, because those are exactly the
ones the observer is allowed to infer (§ 2.3: "not a general program synthesiser"). Evaluation is
the mirror of inference, and the two files stay the same size for the same reason.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from composer.protocol.models import (
    DerivedRuleConcat,
    DerivedRuleCount,
    DerivedRuleDateOffset,
    DerivedRuleMax,
    DerivedRuleMin,
    DerivedRuleSum,
    FieldSpec,
)

DerivedRuleSpec = (
    DerivedRuleSum
    | DerivedRuleCount
    | DerivedRuleMin
    | DerivedRuleMax
    | DerivedRuleDateOffset
    | DerivedRuleConcat
)

Record = dict[str, object]


class UnevaluableRuleError(Exception):
    """A rule whose inputs are not present or not of the shape it needs.

    Raised rather than silently returning `None`, because a derived field left unset is a field
    the application will compute differently from the engine — and the preview would show a value
    the created record does not have.
    """

    def __init__(self, field: str, reason: str) -> None:
        super().__init__(f"cannot evaluate the rule for {field!r}: {reason}")
        self.field: str = field
        self.reason: str = reason


def dependencies(rule: DerivedRuleSpec) -> list[str]:
    """The fields a rule reads. Used to order evaluation so inputs are ready first."""
    if isinstance(rule, DerivedRuleSum | DerivedRuleMin | DerivedRuleMax | DerivedRuleCount):
        return [rule.over_field]
    if isinstance(rule, DerivedRuleDateOffset):
        return [rule.from_field]
    return [entry.root for entry in rule.fields]


def evaluate(spec: FieldSpec, record: Record) -> object:
    """Compute `spec`'s value from the rest of `record`.

    `spec.derived_rule` must be non-null; callers check that before reaching here, because a
    field with no rule is one the sampler owns and this module has nothing to say about it.
    """
    derived = spec.derived_rule
    if derived is None:
        raise UnevaluableRuleError(spec.name, "the field has no derived rule")

    rule = derived.rule

    if isinstance(rule, DerivedRuleCount):
        return len(_group(spec.name, record, rule.over_field))

    if isinstance(rule, DerivedRuleSum | DerivedRuleMin | DerivedRuleMax):
        members = _group(spec.name, record, rule.over_field)
        values = [_number(spec.name, member, rule.of_field) for member in members]
        if not values:
            # An empty group sums to zero; a minimum or maximum over nothing does not exist.
            if isinstance(rule, DerivedRuleSum):
                return 0.0
            raise UnevaluableRuleError(spec.name, f"{rule.over_field} is empty")
        if isinstance(rule, DerivedRuleSum):
            return round(sum(values), 2)
        return round(min(values) if isinstance(rule, DerivedRuleMin) else max(values), 2)

    if isinstance(rule, DerivedRuleDateOffset):
        source = record.get(rule.from_field)
        if not isinstance(source, str):
            raise UnevaluableRuleError(spec.name, f"{rule.from_field} is not a timestamp")
        try:
            moment = datetime.fromisoformat(source.replace("Z", "+00:00"))
        except ValueError as error:
            raise UnevaluableRuleError(
                spec.name, f"{rule.from_field} is not an ISO 8601 timestamp"
            ) from error
        shifted = moment + timedelta(days=rule.offset_days)
        return shifted.isoformat().replace("+00:00", "Z")

    parts: list[str] = []
    for entry in rule.fields:
        value = record.get(entry.root)
        if value is None:
            raise UnevaluableRuleError(spec.name, f"{entry.root} has no value yet")
        parts.append(str(value))
    return rule.separator.join(parts)


def _group(field: str, record: Record, name: str) -> list[dict[str, object]]:
    members = record.get(name)
    if not isinstance(members, list):
        raise UnevaluableRuleError(field, f"{name} is not a repeated group")
    return [member for member in members if isinstance(member, dict)]


def _number(field: str, member: dict[str, object], name: str) -> float:
    value = member.get(name)
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise UnevaluableRuleError(field, f"a member of the group has no numeric {name}")
    return float(value)


def evaluation_order(specs: list[FieldSpec]) -> list[FieldSpec]:
    """Derived fields, ordered so each rule's inputs are computed before it runs.

    The observer refuses to record a cycle, so a plain dependency walk terminates. Any field
    whose dependencies cannot be satisfied from the others is emitted last and will raise a
    readable error when it runs, rather than being dropped from the record.
    """
    derived = [spec for spec in specs if spec.derived_rule is not None]
    by_name = {spec.name: spec for spec in derived}

    ordered: list[FieldSpec] = []
    placed: set[str] = set()

    def place(spec: FieldSpec, seen: frozenset[str]) -> None:
        if spec.name in placed or spec.name in seen:
            return
        rule = spec.derived_rule
        if rule is not None:
            for dependency in dependencies(rule.rule):
                nested = by_name.get(dependency)
                if nested is not None:
                    place(nested, seen | {spec.name})
        if spec.name not in placed:
            placed.add(spec.name)
            ordered.append(spec)

    for spec in derived:
        place(spec, frozenset())
    return ordered
