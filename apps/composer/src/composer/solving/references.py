"""Turning "for Acme Industrial" into a record that actually exists.

docs/TEST-DATA-ENGINE.md § 3 states the rule for reference fields in one line: "prefer an
existing real record; create only if the utterance demands novelty". Both halves matter and they
fail in different ways. Inventing an account for an order that says "for Acme Industrial" gives
the tester an order for the wrong customer — a broken row wearing a plausible name. Creating a
*second* Acme when one exists quietly changes what the test covers, and leaves a duplicate behind
that somebody has to clean up.

## What this module reads

Only `existingRecords` from the request. The composer holds no database handle (docs/ARCHITECTURE
§ 5), so the records the gateway chose to send are the entire universe of "what already exists".
They are read here and nowhere else, they are never persisted, and they never reach a model
prompt — reference *resolution* is local string work, which is exactly what lets the parser be
given the utterance while the customer's data stays behind.

## Novelty is English, not domain language

`NOVELTY_MARKERS` lives here rather than in `parsing/lexicon.py` because it is not read while
parsing: whether "new" in "a new order for a new customer" attaches to the order or the customer
is a question about the *reference target*, which only the solver knows. The words themselves are
ordinary English and carry no customer's domain language, the same discipline the lexicon keeps.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

from composer.parsing.lexicon import field_aliases, normalize
from composer.protocol.models import ExistingRecord

#: Overlap below which a phrase is not considered to name a record. A tester who says "Acme"
#: means the one account whose label contains it; a tester whose phrase shares one common word
#: with a label means nothing of the sort, and creating the record is the safer answer.
MATCH_THRESHOLD = 0.5

#: Words that ask for a record that does not exist yet. Matched immediately before an entity's
#: name, so "a new order for Acme Industrial" creates an order and reuses the account.
NOVELTY_MARKERS: tuple[str, ...] = (
    "brand new",
    "a different",
    "another",
    "new",
    "fresh",
    "additional",
    "second",
)


@dataclass(frozen=True)
class ReferenceMatch:
    """An existing record a phrase was taken to name, and how sure that reading is."""

    record: ExistingRecord
    score: float
    #: How many records of that entity the match was made against. Named in the provenance,
    #: because "matched from 64 known accounts" is what makes the match believable.
    pool_size: int


def records_of(records: list[ExistingRecord], entity: str) -> list[ExistingRecord]:
    """Every supplied record of one entity. Entity names are compared case-insensitively."""
    wanted = entity.casefold()
    return [record for record in records if record.entity.casefold() == wanted]


def _overlap(left: str, right: str) -> float:
    left_tokens = set(left.split())
    right_tokens = set(right.split())
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def match_phrase(
    phrase: str, records: list[ExistingRecord], entity: str
) -> ReferenceMatch | None:
    """The record `phrase` names, or `None` if none of them does.

    Four readings, in descending order of how literal they are:

    1. The phrase *is* an identifier — a tester reading `ACC-1001` off the screen.
    2. The phrase and a label are the same words.
    3. One contains the other — "Acme" for "Acme Industrial Ltd".
    4. Enough words overlap to be the same name said loosely.

    Returning `None` rather than the best of a bad set is deliberate. The caller's response to no
    match is to create the record, which is recoverable; pointing an order at the wrong customer
    is not, because nothing in the preview would look wrong.
    """
    candidates = records_of(records, entity)
    if not candidates:
        return None

    wanted = normalize(phrase)
    if not wanted:
        return None

    best: ReferenceMatch | None = None
    for record in candidates:
        score = _score(wanted, record)
        if score >= MATCH_THRESHOLD and (best is None or score > best.score):
            best = ReferenceMatch(record=record, score=score, pool_size=len(candidates))

    return best


def _score(wanted: str, record: ExistingRecord) -> float:
    if wanted == record.external_ref.casefold() or wanted == normalize(record.external_ref):
        return 1.0

    label = normalize(record.label) if record.label is not None else ""
    if not label:
        return 0.0
    if label == wanted:
        return 1.0
    if wanted in label or label in wanted:
        # Not 1.0: "Acme" matching "Acme Industrial" is right nearly always and wrong when the
        # application also holds an "Acme Logistics". The preview shows which one was chosen.
        return 0.9
    return _overlap(label, wanted)


def label_field(records: list[ExistingRecord], entity: str) -> str | None:
    """Which field of an entity holds the name a tester would use for it.

    Discovered, never configured. Every supplied record carries both its fields and the label the
    application displays for it, so the field whose value *is* that label across most records is
    the display name — `name` in one application, `companyName` or `title` in the next. That is
    the whole reason this can be generic: the answer is in the request, not in a mapping table
    somebody has to maintain per customer.

    Returns `None` when no field agrees with the labels, which is the honest answer when the
    label is composed (`"Acme Industrial (ACC-1001)"`) or when no record carries one. The caller
    treats that as "this reference cannot be created from a phrase" and refuses rather than
    creating a record with the name silently dropped.
    """
    counts: Counter[str] = Counter()
    labelled = 0

    for record in records_of(records, entity):
        if record.label is None:
            continue
        labelled += 1
        wanted = normalize(record.label)
        for name, value in record.fields.items():
            if isinstance(value, str) and normalize(value) == wanted:
                counts[name] += 1

    if labelled == 0 or not counts:
        return None

    name, hits = counts.most_common(1)[0]
    # A majority, not a single coincidence: one record whose `notes` happens to repeat its own
    # name is not evidence that `notes` is the display field.
    return name if hits * 2 > labelled else None


def demands_novelty(utterance: str, entity: str) -> bool:
    """Whether the utterance asks for a *new* record of `entity` rather than an existing one.

    Matched adjacently — "a new customer", not "new" anywhere in the sentence — so that "a new
    order for Acme Industrial" creates the order and reuses the account, which is what it plainly
    means. Without the adjacency check the word "new", which testers say about almost every
    seeding request, would force every reference in the sentence to be created.
    """
    text = normalize(utterance)
    for form in field_aliases(entity):
        for marker in NOVELTY_MARKERS:
            if re.search(rf"\b{re.escape(marker)}\s+{re.escape(form)}\b", text):
                return True
    return False


def taken_values(records: list[ExistingRecord], entity: str, field: str) -> frozenset[object]:
    """Values a unique field already holds, so a draw does not collide with a real record.

    § 3: "Uniqueness → check for collision against observed values before returning". The only
    values the composer can check against are the ones in the request, which is why the gateway
    sends a sample rather than nothing — a `reference` field drawn against an empty set will
    eventually collide, and the application rejects the record for a reason the tester cannot see.
    """
    values: set[object] = set()
    for record in records_of(records, entity):
        value = record.fields.get(field)
        if value is not None and isinstance(value, str | int | float | bool):
            values.add(value)
    return frozenset(values)
