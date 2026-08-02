"""The closed English vocabulary the deterministic parser reads.

Small surface, and worth testing directly rather than only through the parser: every one of these
functions is a decision about what a tester *meant*, and a regression in `field_aliases` shows up
in the parser as a constraint quietly going missing rather than as an obvious failure.
"""

from __future__ import annotations

import pytest

from composer.parsing.lexicon import (
    COMPARISON_PHRASES,
    NUMBER_WORDS,
    field_aliases,
    normalize,
    parse_quantity,
    tokenize,
)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("50000", 50_000.0),
        ("£50,000", 50_000.0),
        ("$1.2m", 1_200_000.0),
        ("3.5k", 3_500.0),
        ("2b", 2_000_000_000.0),
        ("  €900 or so", 900.0),
    ],
)
def test_parse_quantity_reads_numbers_as_a_tester_says_them(text: str, expected: float) -> None:
    assert parse_quantity(text) == expected


def test_parse_quantity_returns_none_when_there_is_no_number() -> None:
    # None rather than zero: "no number here" and "the number is zero" are different answers, and
    # the parser branches on the difference.
    assert parse_quantity("with the usual terms") is None


def test_currency_symbol_is_read_and_discarded() -> None:
    # Which currency an amount is in is a property of the field, not of the utterance.
    assert parse_quantity("£50,000") == parse_quantity("$50,000") == parse_quantity("50000")


def test_normalize_keeps_what_carries_meaning_and_drops_what_does_not() -> None:
    assert normalize("I need an Order — please!") == "i need an order please"
    # Currency symbols, decimal points, commas and hyphens all mean something: they are what make
    # "£50,000" one number rather than two, and "net-30" one term rather than two.
    assert normalize("£50,000 at 1.5 on net-30") == "£50,000 at 1.5 on net-30"


def test_normalize_collapses_whitespace() -> None:
    assert normalize("  an   order \n for  Acme ") == "an order for acme"


def test_tokenize_drops_filler_so_an_unparsed_fragment_means_something() -> None:
    # "I need an order" leaves nothing meaningful behind; if it did, the unparsed-fragment warning
    # would fire on almost every utterance and testers would learn to ignore it.
    assert tokenize("I need an order") == ["order"]
    assert tokenize("with the usual terms") == ["usual", "terms"]


@pytest.mark.parametrize(
    ("field_name", "expected_forms"),
    [
        ("po_number", {"po number", "po numbers", "ponumber", "ponumbers", "number", "numbers"}),
        ("lineItems", {"line items", "line item", "lineitems", "lineitem", "items", "item"}),
        ("status", {"status", "statu"}),
    ],
)
def test_field_aliases_covers_how_a_field_name_is_actually_spoken(
    field_name: str, expected_forms: set[str]
) -> None:
    assert field_aliases(field_name) == expected_forms


def test_field_aliases_of_an_empty_name_is_empty() -> None:
    assert field_aliases("---") == set()


def test_number_words_and_comparison_phrases_carry_no_domain_language() -> None:
    """The guard on CLAUDE.md § "What is generic vs what is per-application".

    A lexicon with `"pending"` in it would be the clearest possible violation of the rule that
    per-application vocabulary is learned, never written down. This asserts the tables hold only
    counting and comparing words — the check is crude on purpose, because the failure it catches
    is somebody adding one convenient entry.
    """
    english = set(NUMBER_WORDS) | set(COMPARISON_PHRASES)
    for phrase in english:
        assert phrase.replace(" ", "").isalpha(), phrase
    assert "pending" not in english
    assert "approved" not in english
