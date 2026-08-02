"""Utterance → `ConstraintSet`, in tiers.

The same three-tier discipline CLAUDE.md § "Resolution tiers" sets for element resolution, applied
to parsing:

| Tier | Mechanism | What it reads |
|------|-----------|---------------|
| T0 | Exact hit | A learned alias, an enum value, or a field name said verbatim |
| T1 | Local fuzzy match | The same tables, matched on token overlap rather than equality |
| T2 | A small fast model | Novel phrasing, escalated once and written back as an alias |

T1 is token-overlap rather than the embedding kNN the resolver uses, because the composer has no
embedder and shipping one to parse "line items" against `line_item` would be a lot of machinery
for a job that string comparison does. The tier means the same thing either way: a local,
sub-millisecond approximation that catches near-misses before anything reaches a model.

## Everything read here is *learned*

The field names, the enum vocabularies and the predicate names all come from the `EntitySchema`
the indexer produced. This module supplies English — counting words, comparison phrasings — and
nothing else. That split is what makes the parser work for an application nobody has seen.

## What is never dropped

docs/TEST-DATA-ENGINE.md § 7: "never silently drop a constraint". A fragment the parser cannot
map is reported in `unparsed_fragments` and shown to the tester, so "with the usual terms" being
ignored is something they find out before approving a record, not after.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from dataclasses import field as dataclass_field

from composer.parsing.lexicon import (
    COMPARISON_PHRASES,
    NUMBER_WORDS,
    REFERENCE_PREPOSITIONS,
    field_aliases,
    normalize,
    parse_quantity,
    tokenize,
)
from composer.protocol.models import (
    ConstraintAlias,
    ConstraintCardinality,
    ConstraintComparison,
    ConstraintEquals,
    ConstraintPredicate,
    ConstraintReference,
    ConstraintSet,
    EntitySchema,
    FieldSpec,
    FieldType,
    Op,
)
from composer.solving.types import Constraint

#: Token overlap above which a T1 fuzzy match is accepted. Below it, escalate rather than guess.
T1_SIMILARITY_THRESHOLD = 0.6

#: Words that end a reference phrase. "for Acme Industrial with three line items" names Acme,
#: not "Acme Industrial with three line items".
_PHRASE_TERMINATORS: tuple[str, ...] = (
    "with",
    "and",
    "that",
    "which",
    "having",
    "containing",
    "worth",
    "over",
    "under",
)


@dataclass
class ParseResult:
    """What one parse produced, and how much it cost to produce it."""

    constraint_set: ConstraintSet
    #: The highest tier any part of this parse reached. `T2` means a model was called.
    tier: str
    #: New phrasings learned this parse, for the gateway to persist. Empty below T2.
    alias_write_backs: list[ConstraintAlias] = dataclass_field(default_factory=list)


@dataclass
class _Working:
    """Parse state: what has been claimed from the utterance, and what is left."""

    text: str
    constraints: list[Constraint] = dataclass_field(default_factory=list)
    #: Spans of the normalised utterance already accounted for, so they are not re-read.
    claimed: list[tuple[int, int]] = dataclass_field(default_factory=list)
    tier: str = "T0"

    def claim(self, start: int, end: int) -> None:
        self.claimed.append((start, end))

    def is_claimed(self, start: int, end: int) -> bool:
        return any(start < c_end and end > c_start for c_start, c_end in self.claimed)

    def remainder(self) -> str:
        """The utterance with every claimed span blanked out."""
        characters = list(self.text)
        for start, end in self.claimed:
            for index in range(max(start, 0), min(end, len(characters))):
                characters[index] = " "
        return "".join(characters)

    def segments(self) -> list[str]:
        """Unclaimed runs of the utterance, in order.

        A claimed span is a *boundary*, not a gap to read across. Without this, a reference
        phrase captured from the remainder of "a pending order for Acme with three line items"
        reads "Acme ... items" as one name — the words either side of a claimed span are not
        adjacent, and treating them as adjacent invents a phrase nobody said.
        """
        return [
            segment.strip() for segment in re.split(r"\s{2,}", self.remainder()) if segment.strip()
        ]


def _similarity(left: str, right: str) -> float:
    """Token-set overlap, the T1 measure. 1.0 is identical, 0.0 shares nothing."""
    left_tokens = set(left.split())
    right_tokens = set(right.split())
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def choose_entity(
    utterance: str, schemas: list[EntitySchema], route_pattern: str
) -> EntitySchema | None:
    """Decide which entity the tester is talking about.

    Three signals, in descending order of how much they commit to:

    1. **The utterance names it.** "an order for Acme" is about an Order, whatever screen the
       tester is on.
    2. **The route says it.** An unqualified "one with three line items" spoken on `/orders` is
       about an order — this is the runtime state earning its place in the request.
    3. **There is only one candidate.** No ambiguity to resolve.

    Returns `None` rather than guessing between several. An engine that composes the wrong
    entity has not misunderstood a detail, it has answered a different question.

    Where the utterance names more than one entity, the **head noun wins** — the one said first.
    "A customer with an overdue invoice" is a request for a customer, and the invoice is a
    condition on it; docs/TEST-DATA-ENGINE.md § 3 works exactly that sentence through and reaches
    the same answer. "An order with three line items" is the same shape and reads the same way. A
    tie at the same position goes to the longer name, which is the more specific reading.
    """
    normalized = normalize(utterance)

    named: list[tuple[int, int, EntitySchema]] = []
    for schema in schemas:
        positions = [
            normalized.find(form)
            for form in field_aliases(schema.entity_name)
            if normalized.find(form) >= 0
        ]
        if positions:
            named.append((min(positions), -len(schema.entity_name), schema))

    if named:
        return min(named, key=lambda entry: (entry[0], entry[1]))[2]

    from_route = [
        schema
        for schema in schemas
        if any(form in route_pattern.lower() for form in field_aliases(schema.entity_name))
    ]
    if len(from_route) == 1:
        return from_route[0]

    return schemas[0] if len(schemas) == 1 else None


class ConstraintParser:
    """Reads an utterance against one learned schema."""

    def __init__(
        self,
        schema: EntitySchema,
        aliases: list[ConstraintAlias],
        related: list[EntitySchema] | None = None,
    ) -> None:
        self._schema = schema
        self._aliases = [alias for alias in aliases if alias.entity == schema.entity_name]
        # Predicates of *other* entities are readable too. "A customer with an overdue invoice"
        # names a condition that does not belong to the entity being composed — `overdue` is
        # learned on `Invoice` — and a parser that could only see the head noun's own predicates
        # would report the most interesting half of that sentence as an unparsed fragment. Fields,
        # enum vocabularies and references stay strictly local: they are assignments to *this*
        # record, and reading another entity's field names into it would invent constraints.
        self._related = [
            entry for entry in (related or []) if entry.entity_name != schema.entity_name
        ]

    def parse(self, utterance: str) -> ParseResult:
        working = _Working(text=normalize(utterance))

        # Order matters. Aliases first because a learned phrasing may cover several constraints
        # at once and should not be picked apart by the narrower passes below it.
        self._read_aliases(working)
        self._read_predicates(working)
        self._read_comparisons(working)
        self._read_cardinalities(working)
        self._read_enum_values(working)
        self._read_references(working)
        self._claim_bare_field_names(working)

        unparsed = self._unparsed_fragments(working)

        return ParseResult(
            constraint_set=ConstraintSet(
                entity=self._schema.entity_name,
                constraints=working.constraints,
                confidence=self._confidence(working, unparsed),
                unparsed_fragments=unparsed,
            ),
            tier=working.tier,
        )

    # ── T0: learned aliases ───────────────────────────────────────────────────────────────

    def _read_aliases(self, working: _Working) -> None:
        """A phrasing somebody already paid a model call for.

        This is the write-back loop closing: the second tester to say "high value" gets the
        answer for free. Longest first, so a learned "high value order" wins over "high value".
        """
        for alias in sorted(self._aliases, key=lambda entry: -len(entry.phrase)):
            phrase = normalize(alias.phrase)
            start = working.text.find(phrase)
            if start < 0 or working.is_claimed(start, start + len(phrase)):
                continue

            working.claim(start, start + len(phrase))
            working.constraints.extend(alias.constraints)

    # ── T0/T1: predicates ─────────────────────────────────────────────────────────────────

    def _read_predicates(self, working: _Working) -> None:
        """Learned named conditions — "overdue", "expired", "high value".

        A predicate is not a field assignment, which is why it is read before the field passes:
        "overdue" must not be mistaken for a value of some field that happens to contain the
        word. The solver expands it into the clauses the indexer learned.

        A predicate belonging to a related entity also claims that entity's name where it appears
        next to it. In "an account with an overdue invoice" the word `invoice` is not a leftover —
        it says which record the condition is about — and reporting it as unparsed would tell the
        tester something was ignored when nothing was.
        """
        local = [(predicate, False) for predicate in self._schema.predicates]
        foreign = [(predicate, True) for schema in self._related for predicate in schema.predicates]

        for predicate, is_foreign in local + foreign:
            name = normalize(predicate.name)
            start = working.text.find(name)
            if start < 0 or working.is_claimed(start, start + len(name)):
                continue

            working.claim(start, start + len(name))
            working.constraints.append(ConstraintPredicate(kind="predicate", name=predicate.name))

            if is_foreign:
                for form in field_aliases(predicate.entity):
                    position = working.text.find(form)
                    if position >= 0 and not working.is_claimed(position, position + len(form)):
                        working.claim(position, position + len(form))

    # ── T0/T1: comparisons ────────────────────────────────────────────────────────────────

    def _read_comparisons(self, working: _Working) -> None:
        """ "over £50,000", "at least three", "under 100".

        Read before cardinality because "more than three line items" is a comparison on a count,
        not a count — and before enum values because a phrase like "over 50" must not be matched
        against a vocabulary entry that happens to contain "50".
        """
        for phrase in sorted(COMPARISON_PHRASES, key=len, reverse=True):
            for match in re.finditer(rf"\b{re.escape(phrase)}\b", working.text):
                if working.is_claimed(match.start(), match.end()):
                    continue

                tail = working.text[match.end() :]
                value = parse_quantity(tail)
                if value is None:
                    continue

                target = (
                    self._field_for(working.text[: match.start()], tail) or self._numeric_field()
                )
                if target is None:
                    continue

                quantity_end = match.end() + self._quantity_span_end(tail)
                working.claim(match.start(), quantity_end)
                working.constraints.append(
                    ConstraintComparison(
                        kind="comparison",
                        field=target.name,
                        op=Op(COMPARISON_PHRASES[phrase]),
                        value=value,
                    )
                )
                break

    @staticmethod
    def _quantity_span_end(tail: str) -> int:
        from composer.parsing.lexicon import QUANTITY

        match = QUANTITY.search(tail)
        return match.end() if match is not None else 0

    # ── T0/T1: cardinality ────────────────────────────────────────────────────────────────

    def _read_cardinalities(self, working: _Working) -> None:
        """ "three line items" — a count over a repeatable group.

        Only `group` fields are candidates. "three" next to a scalar field is not a cardinality;
        it is either a value or something the parser should admit it did not understand.
        """
        groups = [field for field in self._schema.fields if field.type == FieldType.GROUP]
        if not groups:
            return

        for group in groups:
            for form in sorted(field_aliases(group.name), key=len, reverse=True):
                for match in re.finditer(rf"\b{re.escape(form)}\b", working.text):
                    if working.is_claimed(match.start(), match.end()):
                        continue

                    before = working.text[: match.start()]
                    counted = self._trailing_count(before)
                    if counted is None:
                        continue
                    count, count_start = counted

                    # From the first character of the count word to the last of the group name,
                    # so neither "three" nor "line items" is left behind as an unparsed fragment.
                    working.claim(count_start, match.end())
                    working.constraints.append(
                        ConstraintCardinality(kind="cardinality", field=group.name, count=count)
                    )
                    break

    @staticmethod
    def _trailing_count(before: str) -> tuple[int, int] | None:
        """The count immediately preceding a group name, with where it starts.

        Returns `(count, start_index)` so the caller can claim the count and the group name as
        one span. Multi-word counts ("a couple of") are checked before single words, because
        "of" is a filler that would otherwise strand "a couple".
        """
        stripped = before.rstrip()
        if not stripped:
            return None

        for size in (3, 2):
            words = stripped.split()
            if len(words) >= size:
                joined = " ".join(words[-size:])
                if joined in NUMBER_WORDS:
                    return NUMBER_WORDS[joined], len(stripped) - len(joined)

        last = stripped.split()[-1]
        start = len(stripped) - len(last)
        if last.isdigit():
            return int(last), start
        if last in NUMBER_WORDS:
            return NUMBER_WORDS[last], start
        return None

    # ── T0/T1: enum values ────────────────────────────────────────────────────────────────

    def _read_enum_values(self, working: _Working) -> None:
        """A learned vocabulary entry said out loud — "pending", "net30".

        Exact containment is T0. Where that misses, token overlap catches "pending approval"
        said as "approval pending" without a model call, which is what T1 is for.
        """
        for spec in self._schema.fields:
            if not spec.enum_values:
                continue
            if any(
                isinstance(constraint, ConstraintEquals) and constraint.field == spec.name
                for constraint in working.constraints
            ):
                continue

            values = [entry.root for entry in spec.enum_values]

            matched = False
            for value in sorted(values, key=len, reverse=True):
                normalized = normalize(value)
                start = working.text.find(normalized)
                if start < 0 or working.is_claimed(start, start + len(normalized)):
                    continue
                working.claim(start, start + len(normalized))
                working.constraints.append(
                    ConstraintEquals(kind="equals", field=spec.name, value=value)
                )
                matched = True
                break

            if matched:
                continue

            best_value, best_score = self._best_fuzzy(working.remainder(), values)
            if best_value is not None and best_score >= T1_SIMILARITY_THRESHOLD:
                working.tier = "T1" if working.tier == "T0" else working.tier
                working.constraints.append(
                    ConstraintEquals(kind="equals", field=spec.name, value=best_value)
                )
                for token in normalize(best_value).split():
                    position = working.text.find(token)
                    if position >= 0:
                        working.claim(position, position + len(token))

    @staticmethod
    def _best_fuzzy(text: str, values: list[str]) -> tuple[str | None, float]:
        normalized = normalize(text)
        best: tuple[str | None, float] = (None, 0.0)
        for value in values:
            score = _similarity(normalize(value), normalized)
            if score > best[1]:
                best = (value, score)
        return best

    # ── T0: references ────────────────────────────────────────────────────────────────────

    def _read_references(self, working: _Working) -> None:
        """ "for Acme Industrial" — a pointer at a record, named by a phrase.

        The *phrase* is captured, not resolved: turning it into a record is the solver's job,
        against records the parser never sees. That separation is what keeps a customer's data
        out of any model prompt (see `escalate.py`).
        """
        reference_fields = [
            spec for spec in self._schema.fields if spec.references_entity is not None
        ]
        if not reference_fields:
            return

        for segment in working.segments():
            for preposition in sorted(REFERENCE_PREPOSITIONS, key=len, reverse=True):
                match = re.search(
                    rf"\b{re.escape(preposition)}\s+(?P<phrase>.+?)"
                    rf"(?=\s+\b(?:{'|'.join(_PHRASE_TERMINATORS)})\b|$)",
                    segment,
                )
                if match is None:
                    continue

                phrase = match.group("phrase").strip(" .,")
                if not phrase:
                    continue

                target = self._reference_field_for(phrase, reference_fields)
                start = working.text.find(match.group(0))
                if start >= 0:
                    working.claim(start, start + len(match.group(0)))
                working.constraints.append(
                    ConstraintReference(kind="reference", field=target.name, phrase=phrase)
                )
                return

    def _reference_field_for(self, phrase: str, candidates: list[FieldSpec]) -> FieldSpec:
        """Which reference field a phrase belongs to.

        With one reference field there is no choice. With several — an order pointing at both an
        account and a warehouse — the entity name in the phrase decides, and failing that the
        first field, which the solver will show in the preview for the tester to correct.
        """
        if len(candidates) == 1:
            return candidates[0]

        normalized = normalize(phrase)
        for spec in candidates:
            target = spec.references_entity or ""
            if any(form in normalized for form in field_aliases(target)):
                return spec
        return candidates[0]

    # ── Field resolution ──────────────────────────────────────────────────────────────────

    def _field_for(self, before: str, after: str) -> FieldSpec | None:
        """The field a comparison is about, named on either side of the operator."""
        context = f"{before} {after}"
        best: tuple[FieldSpec | None, int] = (None, 0)
        for spec in self._schema.fields:
            for form in field_aliases(spec.name):
                if re.search(rf"\b{re.escape(form)}\b", context) and len(form) > best[1]:
                    best = (spec, len(form))
        return best[0]

    def _numeric_field(self) -> FieldSpec | None:
        """The field a bare comparison is probably about.

        "over £50,000" with no field named is unambiguous when exactly one numeric field could
        carry a currency amount. Where several could, the parser declines and the fragment is
        reported unparsed rather than attached to whichever came first.

        A *derived* field is a candidate. "an order over £50,000" is a perfectly ordinary request
        even when the total is the sum of the line items — it constrains the group rather than
        the total directly, and the solver either satisfies it that way or reports the conflict.
        Excluding derived fields here would silently drop the only constraint in the sentence.

        Group members are excluded: `lines.amount` is a member of a repeated group, so a bare
        comparison cannot be about it without saying which member.
        """
        numeric = [
            spec
            for spec in self._schema.fields
            if spec.type in (FieldType.CURRENCY, FieldType.NUMBER, FieldType.INTEGER)
            and "." not in spec.name
        ]
        return numeric[0] if len(numeric) == 1 else None

    def _claim_bare_field_names(self, working: _Working) -> None:
        """Claim field names left over after every meaning-bearing pass.

        "net30 terms" and "three line items" each name a field beside the thing being asked for.
        Once the requirement has been read, the name itself carries nothing — reporting it as an
        unparsed fragment would cry wolf on almost every utterance and teach testers to ignore
        the warning that exists to tell them a real clause was dropped.
        """
        for spec in self._schema.fields:
            for form in sorted(field_aliases(spec.name), key=len, reverse=True):
                for match in re.finditer(rf"\b{re.escape(form)}\b", working.text):
                    if not working.is_claimed(match.start(), match.end()):
                        working.claim(match.start(), match.end())

    # ── What went unread ──────────────────────────────────────────────────────────────────

    def _unparsed_fragments(self, working: _Working) -> list[str]:
        """Content words nobody claimed.

        Filler, the entity's own name and a stranded preposition are all excluded — "I need an
        order" leaves nothing meaningful behind, and reporting "order" or "on" as unparsed would
        make the warning worthless by crying wolf on every utterance.

        A preposition on its own carries no requirement. Where one introduced a reference it was
        claimed with the phrase; where it did not, "on" left over from "on net30 terms" is a word,
        not a clause somebody dropped, and the whole value of this list is that everything in it
        is worth a tester's attention.
        """
        entity_forms = field_aliases(self._schema.entity_name)
        leftovers = [
            token
            for token in tokenize(working.remainder())
            if token not in entity_forms
            and token not in REFERENCE_PREPOSITIONS
            and not token.isdigit()
        ]
        return [" ".join(leftovers)] if leftovers else []

    def _confidence(self, working: _Working, unparsed: list[str]) -> float:
        """How much of what was said the parser accounts for.

        Not an average of per-constraint scores: the risk in a parse is not that one constraint
        is slightly wrong, it is that a whole clause was ignored. Confidence therefore tracks
        coverage, and an utterance with an unread fragment scores lower however confident the
        parser is about the parts it did read.
        """
        if not working.constraints:
            return 0.0

        score = 0.95 if working.tier == "T0" else 0.8
        if unparsed:
            score -= 0.25
        return max(round(score, 2), 0.1)
