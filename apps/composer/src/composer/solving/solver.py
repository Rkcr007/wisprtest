"""The solver: a parsed constraint set becomes a graph of records, or an honest refusal.

docs/TEST-DATA-ENGINE.md § 3 fixes the order of work, and the order is not a preference:

    a. satisfy explicit constraints
    b. resolve references against real records (Acme Industrial exists → use its id)
    c. fill required-but-unspecified from ValueSampler
    d. check predicate constraints ("overdue" ⇒ back-date due_date)
    e. evaluate derived rules last (amount = Σ lines = $46,200)

Each stage may only overwrite what an earlier one chose where doing so is the point. References
run after explicit constraints because a phrase the tester said outranks an automatic pick.
Sampling runs after both because it only fills what is still empty. Predicates run after sampling
because a drawn value that already satisfies the condition should be kept. And derived rules run
last because they are the application's own arithmetic over the values that were *finally* chosen
— computing `amount` before `lines` exist produces a record whose total does not match itself.

## Nothing is ever silently dropped

§ 7 puts it plainly: "never silently drop a constraint". This module takes that literally in three
places. It refuses to overwrite a value the tester asked for, even when a predicate wants to. It
re-checks every constraint against the finished record and reports a conflict if any of them stops
holding. And where a requirement cannot be satisfied at all, it says which two things collide
rather than satisfying whichever came last.

## The output is a graph

Also § 3, also not a preference: "The output is a DAG of records, not one record." A reference
that matches nothing real becomes a second node, and the edge between them is what tells the
gateway which record to create first. "A customer with an overdue invoice" is the worked example
in the doc, and it arrives here in one of two shapes depending on which noun the parser took as
the head — either an Account with an Invoice hanging off it, or an Invoice whose required account
does not exist yet. Both produce Account before Invoice, because both produce the same edge.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from composer.protocol.models import (
    ConflictSideConstraint,
    ConflictSideSchema,
    ConstraintCardinality,
    ConstraintComparison,
    ConstraintConflict,
    ConstraintEquals,
    ConstraintPredicate,
    ConstraintReference,
    DerivedRuleSum,
    DistributionNumeric,
    EntitySchema,
    ExistingRecord,
    FieldSpec,
    FieldType,
    Mode,
    Op,
    PredicateDefinition,
    ProvenanceSource,
)
from composer.solving import derived as derived_rules
from composer.solving import predicates as predicate_solving
from composer.solving.graph import PlanGraph, PlanNode
from composer.solving.provenance import ProvenanceBuilder
from composer.solving.references import (
    ReferenceMatch,
    demands_novelty,
    label_field,
    match_phrase,
    records_of,
    taken_values,
)
from composer.solving.sampler import SampledValue, UniquenessExhaustedError, ValueSampler
from composer.solving.types import Constraint

#: How deep a chain of required references may go before the solver stops following it.
#:
#: Not a performance guard. A required reference chain longer than this is almost always a schema
#: the indexer read wrong, and following it produces a plan asking a tester to approve the creation
#: of a dozen records they never mentioned. Refusing names the field that started it.
MAX_REFERENCE_DEPTH = 4

#: Group size used when a repeated group has a cardinality nobody stated and no observed shape.
DEFAULT_GROUP_SIZE = 1

_NUMERIC_TYPES = (FieldType.INTEGER, FieldType.NUMBER, FieldType.CURRENCY)


# ── What a solve concludes ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Solved:
    """A graph of records, ordered, with every constraint verified against it."""

    graph: PlanGraph
    root_node_id: str


@dataclass(frozen=True)
class Conflicted:
    """Two requirements that cannot both hold, named."""

    conflict: ConstraintConflict


@dataclass(frozen=True)
class Refused:
    """The schema does not describe enough to compose from, and these are the fields."""

    entity: str
    missing_fields: list[str]
    reason: str


SolveOutcome = Solved | Conflicted | Refused


# The two classes below are named `Signal` rather than `Error`, against N818, deliberately.
# Neither is a failure — a conflict and a refusal are *answers*, as `errors.py` explains at length,
# and both leave this module as ordinary return values. They are exceptions purely because a
# reference chain is solved recursively and there is no return path from four frames down that does
# not thread an outcome type through every intermediate signature.


class _ConflictSignal(Exception):  # noqa: N818
    """Internal unwind for a conflict found partway down a reference chain."""

    def __init__(self, conflict: ConstraintConflict) -> None:
        super().__init__(conflict.explanation)
        self.conflict = conflict


class _RefusalSignal(Exception):  # noqa: N818
    """Internal unwind for a refusal found partway down a reference chain."""

    def __init__(self, entity: str, fields: list[str], reason: str) -> None:
        super().__init__(reason)
        self.entity = entity
        self.fields = fields
        self.reason = reason


# ── The solver ────────────────────────────────────────────────────────────────────────────────


class ConstraintSolver:
    """Turns one parsed constraint set into a composition graph. Holds no state between solves."""

    def __init__(
        self,
        *,
        schemas: Sequence[EntitySchema],
        existing_records: Sequence[ExistingRecord],
        utterance: str,
        now: datetime,
        sampler: ValueSampler,
        parse_confidence: float,
    ) -> None:
        self._schemas = list(schemas)
        self._by_entity = {schema.entity_name: schema for schema in self._schemas}
        self._records = list(existing_records)
        self._utterance = utterance
        self._now = now
        self._sampler = sampler
        self._parse_confidence = parse_confidence
        self._graph = PlanGraph()

    def solve(self, schema: EntitySchema, constraints: Sequence[Constraint]) -> SolveOutcome:
        """Compose `schema` under `constraints`, or say why it cannot be done."""
        try:
            root = self._solve_node(schema, list(constraints), stack=(), bound={})
        except _ConflictSignal as signal:
            return Conflicted(conflict=signal.conflict)
        except _RefusalSignal as signal:
            return Refused(entity=signal.entity, missing_fields=signal.fields, reason=signal.reason)

        # Raises PlanCycleError rather than emitting a partial order; see graph.py for why that is
        # the one place refusing to answer is obviously right.
        self._graph.materialization_order()
        return Solved(graph=self._graph, root_node_id=root.node_id)

    # ── One record ────────────────────────────────────────────────────────────────────────

    def _solve_node(
        self,
        schema: EntitySchema,
        constraints: list[Constraint],
        *,
        stack: tuple[str, ...],
        bound: dict[str, str],
    ) -> PlanNode:
        """Compose one record. `bound` names fields already committed to an existing plan node."""
        node = self._graph.add(
            PlanNode(
                node_id=self._graph.next_node_id(schema.entity_name),
                schema=schema,
                mode=Mode.CREATE,
            )
        )
        provenance = ProvenanceBuilder()
        specs = {spec.name: spec for spec in schema.fields if "." not in spec.name}
        descended = (*stack, schema.entity_name)

        for field, target_node_id in bound.items():
            spec = self._require_spec(schema, specs, field)
            node.fields[spec.name] = None
            provenance.pending_reference(
                spec.name,
                entity=spec.references_entity or schema.entity_name,
                node_id=target_node_id,
            )
            self._graph.connect(node.node_id, target_node_id, spec.name)

        # (a) Explicit constraints.
        comparisons = [entry for entry in constraints if isinstance(entry, ConstraintComparison)]
        cardinalities = {
            entry.field: entry.count
            for entry in constraints
            if isinstance(entry, ConstraintCardinality)
        }
        self._apply_equals(node, provenance, schema, specs, constraints)
        self._apply_comparisons(node, provenance, schema, specs, comparisons)

        # (b) References.
        self._apply_references(node, provenance, schema, specs, constraints, descended, bound)

        # (c) Required-but-unspecified.
        self._fill_unspecified(node, provenance, schema, specs, cardinalities, descended)

        # (d) Predicates.
        applied = self._apply_predicates(node, provenance, schema, specs, constraints, descended)

        # (e) Derived rules, last.
        self._apply_derived(node, provenance, schema, specs, comparisons, constraints)

        node.provenance = provenance.entries()
        self._verify(node, constraints, applied)
        return node

    # ── (a) Explicit constraints ──────────────────────────────────────────────────────────

    def _apply_equals(
        self,
        node: PlanNode,
        provenance: ProvenanceBuilder,
        schema: EntitySchema,
        specs: dict[str, FieldSpec],
        constraints: list[Constraint],
    ) -> None:
        for entry in constraints:
            if not isinstance(entry, ConstraintEquals):
                continue
            spec = self._require_spec(schema, specs, entry.field)
            node.fields[spec.name] = entry.value
            provenance.requested(spec.name, entry.value, self._parse_confidence)

    def _apply_comparisons(
        self,
        node: PlanNode,
        provenance: ProvenanceBuilder,
        schema: EntitySchema,
        specs: dict[str, FieldSpec],
        comparisons: list[ConstraintComparison],
    ) -> None:
        """ "over £50,000" — a bound, not a value.

        A comparison on a *derived* field is deliberately not satisfied here. `amount` is computed
        by the application from the line items, so writing a number into it now would be overwritten
        in stage (e) and the tester's bound would vanish. Stage (e) satisfies it by working
        backwards into the group instead.
        """
        for field in dict.fromkeys(entry.field for entry in comparisons):
            spec = self._require_spec(schema, specs, field)
            if spec.derived_rule is not None:
                continue
            if spec.type not in _NUMERIC_TYPES:
                raise _ConflictSignal(
                    ConstraintConflict(
                        left=ConflictSideConstraint(
                            kind="constraint",
                            constraint=next(entry for entry in comparisons if entry.field == field),
                        ),
                        right=ConflictSideSchema(
                            kind="schema",
                            field=field,
                            detail=f"is a {spec.type.value} field, which has no ordering",
                        ),
                        field=field,
                        explanation=(
                            f"{field} was given a numeric bound, but this application stores it "
                            f"as {spec.type.value}"
                        ),
                    )
                )

            relevant = [entry for entry in comparisons if entry.field == field]
            low, high = self._bounds(spec, relevant)
            drawn = self._sampler.sample_within(spec, low, high)
            node.fields[spec.name] = drawn.value
            provenance.requested_within_bounds(
                spec.name,
                drawn.value,
                self._phrase_bounds(relevant),
                min(self._parse_confidence, drawn.confidence),
            )

    def _bounds(
        self, spec: FieldSpec, comparisons: list[ConstraintComparison]
    ) -> tuple[float, float]:
        """The numeric interval a set of comparisons on one field allows.

        Strict operators are stepped off the boundary by the smallest amount the field's type can
        represent — one for an integer, a hundredth otherwise. "Over 50,000" that returns exactly
        50,000 is the kind of off-by-one a tester only discovers when the assertion they were
        testing passes for the wrong reason.
        """
        step = 1.0 if spec.type is FieldType.INTEGER else 0.01
        low, high = -math.inf, math.inf

        for entry in comparisons:
            if entry.op is Op.GT:
                low = max(low, entry.value + step)
            elif entry.op is Op.GTE:
                low = max(low, entry.value)
            elif entry.op is Op.LT:
                high = min(high, entry.value - step)
            else:
                high = min(high, entry.value)

        # An open side is closed against the observed range where there is one, and against the
        # stated bound where there is not — a half-open interval has no value to draw uniformly
        # from, and picking an arbitrary ceiling is how a "over £50,000" request becomes £4bn.
        shape = spec.distribution.shape if spec.distribution is not None else None
        observed = shape if isinstance(shape, DistributionNumeric) else None
        span = (observed.max - observed.min) if observed is not None else None

        if low == -math.inf:
            floor = observed.min if observed is not None else high - max(abs(high) * 0.5, 1.0)
            low = min(floor, high)
        if high == math.inf:
            ceiling = (
                observed.max
                if observed is not None and observed.max > low
                else low + (span if span is not None and span > 0 else max(abs(low) * 0.5, 1.0))
            )
            high = max(ceiling, low)

        return low, high

    @staticmethod
    def _phrase_bounds(comparisons: list[ConstraintComparison]) -> str:
        words = {Op.GT: "over", Op.GTE: "at least", Op.LT: "under", Op.LTE: "at most"}
        return " and ".join(f"{words[entry.op]} {entry.value:g}" for entry in comparisons)

    # ── (b) References ────────────────────────────────────────────────────────────────────

    def _apply_references(
        self,
        node: PlanNode,
        provenance: ProvenanceBuilder,
        schema: EntitySchema,
        specs: dict[str, FieldSpec],
        constraints: list[Constraint],
        stack: tuple[str, ...],
        bound: dict[str, str],
    ) -> None:
        """Phrases the tester said, then required pointers they did not mention."""
        for entry in constraints:
            if not isinstance(entry, ConstraintReference) or entry.field in bound:
                continue
            spec = self._require_spec(schema, specs, entry.field)
            target = self._reference_target(schema, spec)
            self._attach_reference(node, provenance, spec, target, entry.phrase, stack)

        for spec in schema.fields:
            if (
                "." in spec.name
                or spec.references_entity is None
                or not spec.required
                or spec.name in node.fields
                or spec.name in bound
            ):
                continue
            target = self._reference_target(schema, spec)
            self._attach_reference(node, provenance, spec, target, None, stack)

    def _attach_reference(
        self,
        node: PlanNode,
        provenance: ProvenanceBuilder,
        spec: FieldSpec,
        target: str,
        phrase: str | None,
        stack: tuple[str, ...],
    ) -> None:
        """Point `spec` at a real record if one fits, and at a new node if none does.

        § 3: "prefer an existing real record; create only if the utterance demands novelty". Both
        halves fail differently — inventing an account for "for Acme Industrial" gives the tester
        a broken row wearing a plausible name, and creating a second Acme leaves a duplicate behind
        that changes what the test covered.
        """
        novelty = demands_novelty(self._utterance, target)
        match = None if novelty else self._match_reference(phrase, target)

        if match is not None:
            reused = self._graph.reused_node_for(target, match.record.external_ref)
            if reused is None:
                reused = self._graph.add(
                    PlanNode(
                        node_id=self._graph.next_node_id(target),
                        schema=self._by_entity[target],
                        mode=Mode.REUSE_EXISTING,
                        existing_external_ref=match.record.external_ref,
                    )
                )
            self._graph.connect(node.node_id, reused.node_id, spec.name)
            node.fields[spec.name] = match.record.external_ref
            provenance.reference_matched(
                spec.name,
                match.record.external_ref,
                entity=target,
                phrase=phrase,
                pool_size=match.pool_size,
                confidence=match.score if phrase is not None else 0.7,
            )
            return

        child = self._create_referenced(spec, target, phrase, stack)
        self._graph.connect(node.node_id, child.node_id, spec.name)
        node.fields[spec.name] = None
        provenance.pending_reference(spec.name, entity=target, node_id=child.node_id)

    def _match_reference(self, phrase: str | None, target: str) -> ReferenceMatch | None:
        """The record a reference should point at: the one named, or any one that exists.

        With no phrase there is nothing to match *on*, so any record of the right entity will do —
        the tester asked for an order and every order belongs to some account. The pick comes from
        the seeded generator so the same request composes the same plan twice.
        """
        if phrase is not None:
            return match_phrase(phrase, self._records, target)

        pool = records_of(self._records, target)
        if not pool:
            return None
        return ReferenceMatch(record=self._sampler.choose(pool), score=0.7, pool_size=len(pool))

    def _create_referenced(
        self, spec: FieldSpec, target: str, phrase: str | None, stack: tuple[str, ...]
    ) -> PlanNode:
        if target not in self._by_entity:
            raise _RefusalSignal(
                stack[0],
                [spec.name],
                f"{spec.name} points at a {target}, and no {target} matched what you said, but "
                f"this memory version holds no schema for {target} so one cannot be created",
            )
        if target in stack:
            raise _RefusalSignal(
                stack[0],
                [spec.name],
                f"{spec.name} points back at a {target} that is already being created in this "
                "plan, and no existing record matched — a record cannot be created before itself",
            )
        if len(stack) >= MAX_REFERENCE_DEPTH:
            raise _RefusalSignal(
                stack[0],
                [spec.name],
                f"{spec.name} starts a chain of required references more than "
                f"{MAX_REFERENCE_DEPTH} deep; that is more records than you asked for",
            )

        constraints: list[Constraint] = []
        if phrase is not None:
            named = label_field(self._records, target)
            if named is None:
                raise _RefusalSignal(
                    stack[0],
                    [spec.name],
                    f"no existing {target} matched {phrase!r}, and none of the {target} records "
                    f"supplied show which field holds a {target}'s name, so a new one cannot be "
                    "created with the name you said",
                )
            constraints.append(ConstraintEquals(kind="equals", field=named, value=phrase))

        return self._solve_node(self._by_entity[target], constraints, stack=stack, bound={})

    def _reference_target(self, schema: EntitySchema, spec: FieldSpec) -> str:
        if spec.references_entity is None:
            raise _RefusalSignal(
                schema.entity_name,
                [spec.name],
                f"{spec.name} was read as pointing at another record, but this memory version "
                "does not record what it points at",
            )
        return spec.references_entity

    # ── (c) Required-but-unspecified ──────────────────────────────────────────────────────

    def _fill_unspecified(
        self,
        node: PlanNode,
        provenance: ProvenanceBuilder,
        schema: EntitySchema,
        specs: dict[str, FieldSpec],
        cardinalities: dict[str, int],
        stack: tuple[str, ...],
    ) -> None:
        """Draw what the record needs and nobody named.

        "Needed" is wider than "required": a derived rule reads a group, so a required `amount`
        computed as the sum of `lines` makes `lines` needed even though the schema marks it
        optional. Filling only the fields flagged required would leave the sum with nothing to
        add up, and the record would go to the application with a total of zero.
        """
        needed = self._needed_fields(schema, specs, cardinalities)

        for spec in schema.fields:
            if "." in spec.name or spec.name in node.fields:
                continue
            if spec.derived_rule is not None or spec.references_entity is not None:
                continue
            if spec.name not in needed:
                continue

            if spec.type is FieldType.GROUP:
                stated = cardinalities.get(spec.name)
                size = stated if stated is not None else self._group_size(spec)
                node.fields[spec.name] = self._build_group(schema, spec, size)
                provenance.sampled_group(
                    spec.name,
                    size=size,
                    requested=stated is not None,
                    explanation="which is what this application usually holds",
                    confidence=self._parse_confidence if stated is not None else 0.75,
                )
                continue

            drawn = self._draw(spec, schema)
            node.fields[spec.name] = drawn.value
            provenance.sampled(spec.name, drawn)

    def _needed_fields(
        self,
        schema: EntitySchema,
        specs: dict[str, FieldSpec],
        cardinalities: dict[str, int],
    ) -> set[str]:
        needed = {spec.name for spec in specs.values() if spec.required}
        needed |= set(cardinalities)

        # Walk the derived rules of everything already needed, so their inputs are drawn too.
        pending = [specs[name] for name in list(needed) if name in specs]
        while pending:
            spec = pending.pop()
            rule = spec.derived_rule
            if rule is None:
                continue
            for dependency in derived_rules.dependencies(rule.rule):
                if dependency in needed or dependency not in specs:
                    continue
                needed.add(dependency)
                pending.append(specs[dependency])

        return needed

    def _group_size(self, spec: FieldSpec) -> int:
        """How many members a repeated group gets when nobody said.

        Drawn from the observed shape, which for a group is the *count* distribution the indexer
        learned — an application whose orders carry one to five lines should not be seeded with
        an order carrying forty.
        """
        shape = spec.distribution.shape if spec.distribution is not None else None
        if not isinstance(shape, DistributionNumeric):
            return DEFAULT_GROUP_SIZE
        drawn = _as_number(self._sampler.sample_within(spec, shape.min, shape.max).value)
        return max(round(drawn), 0) if drawn is not None else DEFAULT_GROUP_SIZE

    def _build_group(
        self, schema: EntitySchema, spec: FieldSpec, size: int
    ) -> list[dict[str, object]]:
        members = [
            member
            for member in schema.fields
            if member.name.startswith(f"{spec.name}.") and member.name.count(".") == 1
        ]
        rows: list[dict[str, object]] = []
        for _index in range(size):
            row: dict[str, object] = {}
            for member in members:
                row[member.name.split(".", 1)[1]] = self._draw(member, schema).value
            rows.append(row)
        return rows

    def _draw(self, spec: FieldSpec, schema: EntitySchema) -> SampledValue:
        """One draw, with the uniqueness check § 3 requires done against the supplied records."""
        try:
            return self._sampler.sample(
                spec, taken_values(self._records, schema.entity_name, spec.name)
            )
        except UniquenessExhaustedError as error:
            raise _RefusalSignal(
                schema.entity_name,
                [spec.name],
                f"{spec.name} must be unique, and every value drawn for it collided with a record "
                f"that already exists after {error.attempts} attempts",
            ) from error

    # ── (d) Predicates ────────────────────────────────────────────────────────────────────

    def _apply_predicates(
        self,
        node: PlanNode,
        provenance: ProvenanceBuilder,
        schema: EntitySchema,
        specs: dict[str, FieldSpec],
        constraints: list[Constraint],
        stack: tuple[str, ...],
    ) -> dict[str, PlanNode]:
        """Make each named condition true, on this record or on one hung off it.

        Returns which node absorbed each predicate, so the verification pass checks "overdue"
        against the invoice it was solved on rather than against the account it was asked about.
        """
        absorbed: dict[str, PlanNode] = {}

        for entry in constraints:
            if not isinstance(entry, ConstraintPredicate):
                continue

            local = next((item for item in schema.predicates if item.name == entry.name), None)
            if local is not None:
                self._solve_clauses(node, provenance, schema, specs, entry, local)
                absorbed[entry.name] = node
                continue

            absorbed[entry.name] = self._satellite(node, entry, stack)

        return absorbed

    def _solve_clauses(
        self,
        node: PlanNode,
        provenance: ProvenanceBuilder,
        schema: EntitySchema,
        specs: dict[str, FieldSpec],
        requested: ConstraintPredicate,
        definition: PredicateDefinition,
    ) -> None:
        for clause in definition.clauses:
            spec = self._require_spec(schema, specs, clause.field)
            current = node.fields.get(clause.field)

            if provenance.source_of(
                clause.field
            ) is ProvenanceSource.REQUESTED and not predicate_solving.holds(
                clause, current, self._now
            ):
                # The tester said two things that cannot both hold. Satisfying the predicate here
                # would overwrite their own words, which is § 7's silent drop with extra steps.
                raise _ConflictSignal(
                    ConstraintConflict(
                        left=ConflictSideConstraint(kind="constraint", constraint=requested),
                        right=ConflictSideSchema(
                            kind="schema",
                            field=clause.field,
                            detail=f"you asked for {clause.field} to be {current!r}",
                        ),
                        field=clause.field,
                        explanation=(
                            f"{requested.name!r} requires "
                            f"{predicate_solving.describe(clause, self._now)}, but you asked for "
                            f"{clause.field} to be {current!r}"
                        ),
                    )
                )

            outcome = predicate_solving.solve(
                clause, spec, now=self._now, current=current, sampler=self._sampler
            )
            if isinstance(outcome, predicate_solving.ClauseUnsatisfiable):
                raise _ConflictSignal(
                    ConstraintConflict(
                        left=ConflictSideConstraint(kind="constraint", constraint=requested),
                        right=ConflictSideSchema(
                            kind="schema", field=clause.field, detail=outcome.reason
                        ),
                        field=clause.field,
                        explanation=(
                            f"{requested.name!r} requires {outcome.requirement}, which cannot be "
                            f"arranged: {outcome.reason}"
                        ),
                    )
                )

            node.fields[clause.field] = outcome.value
            provenance.predicate_solved(
                clause.field,
                outcome.value,
                predicate=definition.name,
                requirement=outcome.requirement,
                confidence=(
                    definition.confidence * (0.7 if outcome.outside_observed_range else 1.0)
                ),
            )

    def _satellite(
        self, root: PlanNode, requested: ConstraintPredicate, stack: tuple[str, ...]
    ) -> PlanNode:
        """The multi-entity case: a condition that is not about the record being composed.

        docs/TEST-DATA-ENGINE.md § 3 works this example through in full. "A customer with an
        overdue invoice" is not an assignment to a field of `Account` — `overdue` is a predicate
        on `Invoice`, so the solver walks the referential graph from `Invoice.account` back to the
        `Account` it was asked about, and produces two records with an edge between them.
        """
        owner = next(
            (
                schema
                for schema in self._schemas
                if any(item.name == requested.name for item in schema.predicates)
            ),
            None,
        )
        if owner is None:
            raise _RefusalSignal(
                root.schema.entity_name,
                [],
                f"{requested.name!r} is not a condition this memory version knows about for "
                f"{root.schema.entity_name} or anything it references",
            )

        link = next(
            (
                spec
                for spec in owner.fields
                if spec.references_entity == root.schema.entity_name and "." not in spec.name
            ),
            None,
        )
        if link is None:
            raise _RefusalSignal(
                root.schema.entity_name,
                [],
                f"{requested.name!r} is a condition on {owner.entity_name}, and this memory "
                f"version records no field connecting a {owner.entity_name} to a "
                f"{root.schema.entity_name}",
            )

        return self._solve_node(
            owner,
            [requested],
            stack=stack,
            bound={link.name: root.node_id},
        )

    # ── (e) Derived rules, last ───────────────────────────────────────────────────────────

    def _apply_derived(
        self,
        node: PlanNode,
        provenance: ProvenanceBuilder,
        schema: EntitySchema,
        specs: dict[str, FieldSpec],
        comparisons: list[ConstraintComparison],
        constraints: list[Constraint],
    ) -> None:
        """Compute what the application computes, from the values finally chosen.

        A derived field the tester *constrained* is the interesting case. They cannot set it —
        the application will recompute it — so the constraint is satisfied by working backwards
        into the rule's inputs and then computing forwards again. Where that is impossible the
        collision is reported; it is never quietly resolved in favour of the arithmetic.
        """
        equals = {
            entry.field: entry for entry in constraints if isinstance(entry, ConstraintEquals)
        }

        for spec in derived_rules.evaluation_order(schema.fields):
            if "." in spec.name:
                continue
            rule = spec.derived_rule
            if rule is None:
                continue

            wanted = equals.get(spec.name)
            bounds = [entry for entry in comparisons if entry.field == spec.name]
            if wanted is not None or bounds:
                self._retarget(node, provenance, schema, specs, spec, wanted, bounds)

            missing = [
                name
                for name in derived_rules.dependencies(rule.rule)
                if node.fields.get(name) is None
            ]
            if missing and not spec.required and wanted is None and not bounds:
                # An optional computed field whose inputs are not part of this record. Leaving it
                # out is the honest answer; inventing inputs for it would put values in the record
                # that nothing asked for.
                continue

            try:
                value = derived_rules.evaluate(spec, node.fields)
            except derived_rules.UnevaluableRuleError as error:
                raise _RefusalSignal(
                    schema.entity_name,
                    [spec.name],
                    f"{spec.name} is computed by this application, and it cannot be computed "
                    f"here: {error.reason}",
                ) from error

            node.fields[spec.name] = value
            provenance.derived(
                spec.name,
                value,
                description=derived_rules.describe(spec, node.fields),
                confidence=rule.confidence,
            )

            if wanted is not None and value != wanted.value:
                raise _ConflictSignal(
                    ConstraintConflict(
                        left=ConflictSideConstraint(kind="constraint", constraint=wanted),
                        right=ConflictSideSchema(
                            kind="schema",
                            field=spec.name,
                            detail=(
                                f"is computed as {derived_rules.describe(spec, node.fields)}, "
                                f"which comes to {value!r}"
                            ),
                        ),
                        field=spec.name,
                        explanation=(
                            f"{spec.name} was asked for as {wanted.value!r}, but this application "
                            f"computes it as {derived_rules.describe(spec, node.fields)} and that "
                            f"comes to {value!r}"
                        ),
                    )
                )

    def _retarget(
        self,
        node: PlanNode,
        provenance: ProvenanceBuilder,
        schema: EntitySchema,
        specs: dict[str, FieldSpec],
        spec: FieldSpec,
        wanted: ConstraintEquals | None,
        bounds: list[ConstraintComparison],
    ) -> None:
        """Work a constraint on a computed field backwards into the group it is computed from.

        Only `sum` is invertible in a way a tester would recognise: a total spread across the
        lines. A count, a minimum or a concatenation constrained to a particular value is left
        alone here — the forward evaluation runs, and if it disagrees with what was asked for the
        caller reports the collision rather than pretending.
        """
        rule = spec.derived_rule.rule if spec.derived_rule is not None else None
        if not isinstance(rule, DerivedRuleSum):
            return

        members = node.fields.get(rule.over_field)
        if not isinstance(members, list):
            return

        rows = [row for row in members if isinstance(row, dict)]
        if not rows:
            return

        requested_total = _as_number(wanted.value) if wanted is not None else None
        if requested_total is not None:
            target = requested_total
        elif bounds:
            low, high = self._bounds(spec, bounds)
            drawn = _as_number(self._sampler.sample_within(spec, low, high).value)
            if drawn is None:
                return
            target = drawn
        else:
            return

        share = round(target / len(rows), 2)
        for row in rows[:-1]:
            row[rule.of_field] = share
        rows[-1][rule.of_field] = round(target - share * (len(rows) - 1), 2)

        provenance.group_retargeted(
            rule.over_field,
            size=len(rows),
            total_field=spec.name,
            total=round(target, 2),
            confidence=self._parse_confidence,
        )

    # ── Verification ──────────────────────────────────────────────────────────────────────

    def _verify(
        self,
        node: PlanNode,
        constraints: list[Constraint],
        absorbed: dict[str, PlanNode],
    ) -> None:
        """Re-check every constraint against the finished record.

        The stages above each try to satisfy their own constraints, and each is written not to
        stamp on an earlier one. This pass is what makes that a guarantee rather than an intention:
        a constraint that stopped holding somewhere in the middle is reported as a conflict here,
        which is the difference between § 7's "never silently drop a constraint" being a rule and
        being a comment.
        """
        for entry in constraints:
            if isinstance(entry, ConstraintEquals):
                if node.fields.get(entry.field) != entry.value:
                    raise _ConflictSignal(self._lost(entry, entry.field, node))
            elif isinstance(entry, ConstraintCardinality):
                members = node.fields.get(entry.field)
                if not isinstance(members, list) or len(members) != entry.count:
                    raise _ConflictSignal(self._lost(entry, entry.field, node))
            elif isinstance(entry, ConstraintComparison):
                value = node.fields.get(entry.field)
                if not isinstance(value, int | float) or isinstance(value, bool):
                    raise _ConflictSignal(self._lost(entry, entry.field, node))
                if not _satisfies(float(value), entry):
                    raise _ConflictSignal(self._lost(entry, entry.field, node))
            elif isinstance(entry, ConstraintReference):
                if entry.field not in node.fields:
                    raise _ConflictSignal(self._lost(entry, entry.field, node))
            else:
                target = absorbed.get(entry.name)
                definition = next(
                    (
                        item
                        for item in (target.schema.predicates if target is not None else [])
                        if item.name == entry.name
                    ),
                    None,
                )
                if target is None or definition is None:
                    continue
                for clause in definition.clauses:
                    if not predicate_solving.holds(
                        clause, target.fields.get(clause.field), self._now
                    ):
                        raise _ConflictSignal(self._lost(entry, clause.field, target))

    @staticmethod
    def _lost(entry: Constraint, field: str, node: PlanNode) -> ConstraintConflict:
        return ConstraintConflict(
            left=ConflictSideConstraint(kind="constraint", constraint=entry),
            right=ConflictSideSchema(
                kind="schema",
                field=field,
                detail=(
                    f"the composed {node.schema.entity_name} could not hold this and everything "
                    "else that was asked for at the same time"
                ),
            ),
            field=field,
            explanation=(
                f"{field} could not satisfy everything asked of it — the composed "
                f"{node.schema.entity_name} would not have met this requirement, so no plan was "
                "produced rather than one quietly missing it"
            ),
        )

    # ── Shared ────────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _require_spec(schema: EntitySchema, specs: dict[str, FieldSpec], field: str) -> FieldSpec:
        spec = specs.get(field)
        if spec is None:
            raise _RefusalSignal(
                schema.entity_name,
                [field],
                f"{field} was asked for, and this memory version records no such field on a "
                f"{schema.entity_name}",
            )
        return spec


def _satisfies(value: float, comparison: ConstraintComparison) -> bool:
    if comparison.op is Op.GT:
        return value > comparison.value
    if comparison.op is Op.GTE:
        return value >= comparison.value
    if comparison.op is Op.LT:
        return value < comparison.value
    return value <= comparison.value


def _as_number(value: object) -> float | None:
    """A number, or `None` for anything that only looks like one. `True` is not 1 here."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)
