"""The closed vocabulary the deterministic parser reads.

Everything here is English and the conventions of counting and comparing — "three", "at least",
"more than", "for". None of it is any customer's domain language: the *field names*, the *enum
vocabularies* and the *predicate names* all come from the schema the indexer learned, and this
module never contains one. CLAUDE.md § "What is generic vs what is per-application" is the rule,
and a parser with `"pending"` written in it would be the clearest possible violation.

Keeping the lexicon small is deliberate. It covers the phrasings a tester reaches for without
thinking; anything more inventive escalates to T2, where a model reads it once and the write-back
makes it free forever after. Growing this file is how a parser becomes a grammar nobody can
reason about — the escalation path exists precisely so it does not have to.
"""

from __future__ import annotations

import re

#: Counting words, so "three line items" is a cardinality rather than an unparsed fragment.
NUMBER_WORDS: dict[str, int] = {
    "no": 0,
    "zero": 0,
    "one": 1,
    "a": 1,
    "an": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "a couple of": 2,
    "a few": 3,
    "several": 3,
}

#: Comparison phrasings → the `ConstraintComparison` operator they mean.
COMPARISON_PHRASES: dict[str, str] = {
    "greater than or equal to": "gte",
    "at least": "gte",
    "no less than": "gte",
    "minimum of": "gte",
    "less than or equal to": "lte",
    "at most": "lte",
    "no more than": "lte",
    "up to": "lte",
    "maximum of": "lte",
    "greater than": "gt",
    "more than": "gt",
    "over": "gt",
    "above": "gt",
    "exceeding": "gt",
    "less than": "lt",
    "under": "lt",
    "below": "lt",
    "beneath": "lt",
}

#: Phrasings that introduce a reference to another record — "for Acme Industrial".
REFERENCE_PREPOSITIONS: tuple[str, ...] = (
    "belonging to",
    "assigned to",
    "owned by",
    "linked to",
    "against",
    "for",
    "from",
    "on",
    "to",
)

#: Words that carry no requirement. Dropped before deciding whether a fragment went unparsed.
FILLER_WORDS: frozenset[str] = frozenset(
    {
        "i",
        "need",
        "want",
        "give",
        "get",
        "me",
        "a",
        "an",
        "the",
        "some",
        "please",
        "can",
        "you",
        "make",
        "create",
        "new",
        "with",
        "and",
        "that",
        "is",
        "has",
        "have",
        "of",
        "in",
        "it",
        "one",
        "set",
        "up",
        "there",
        "should",
        "be",
        "test",
        "data",
        "record",
        "then",
        "also",
        "plus",
    }
)

#: `£50,000`, `$1.2m`, `1200`, `3.5k` — a number as a tester says it.
QUANTITY = re.compile(
    r"(?P<currency>[$£€¥₹])?\s*(?P<number>\d[\d,]*(?:\.\d+)?)\s*(?P<magnitude>[kmb]\b)?",
    re.IGNORECASE,
)

_MAGNITUDES: dict[str, int] = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}


def parse_quantity(text: str) -> float | None:
    """Read the first number out of `text`, honouring grouping and magnitude suffixes.

    `50k` is fifty thousand, `1.2m` is 1.2 million, and `£50,000` is fifty thousand — the
    currency symbol is read and discarded, because which currency an amount is in is a property
    of the field, not of the utterance.
    """
    match = QUANTITY.search(text)
    if match is None:
        return None

    try:
        value = float(match.group("number").replace(",", ""))
    except ValueError:
        return None

    magnitude = (match.group("magnitude") or "").lower()
    return value * _MAGNITUDES.get(magnitude, 1)


def normalize(text: str) -> str:
    """Lowercase, strip punctuation that carries no meaning, and collapse whitespace.

    Currency symbols, decimal points and hyphens survive: `£50,000`, `1.5` and `net-30` all mean
    something. Sentence punctuation does not.
    """
    lowered = text.lower()
    stripped = re.sub(r"[^\w\s$£€¥₹.,\-']", " ", lowered)
    return re.sub(r"\s+", " ", stripped).strip()


def tokenize(text: str) -> list[str]:
    """Content words of `text`, with filler removed. Used to judge what went unparsed."""
    return [word for word in normalize(text).split() if word and word not in FILLER_WORDS]


def field_aliases(field_name: str) -> set[str]:
    """The ways a tester might say a field's name.

    `po_number` is said "po number"; `lineItems` is said "line items". Splitting on separators
    and camel-case boundaries covers both without the schema having to declare a display name.
    """
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", field_name)
    words = [word for word in re.split(r"[^A-Za-z0-9]+", spaced) if word]
    if not words:
        return set()

    lowered = [word.lower() for word in words]
    forms = {" ".join(lowered), "".join(lowered)}

    # The last word alone: "amount" for `order_amount`, "items" for `line_items`. Ambiguous
    # across fields, so the parser only falls back to it when nothing else matched.
    if len(lowered) > 1:
        forms.add(lowered[-1])

    # Singular and plural, since "three line item" and "three line items" are the same request.
    for form in list(forms):
        forms.add(f"{form}s" if not form.endswith("s") else form[:-1])

    return {form for form in forms if form}
