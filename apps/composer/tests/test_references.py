"""Turning "for Acme Industrial" into a record that actually exists.

§ 3 states the rule in one line: "prefer an existing real record; create only if the utterance
demands novelty". Both halves fail differently and both failures are expensive — inventing an
account for an order that says "for Acme Industrial" gives the tester a broken row wearing a
plausible name, and creating a *second* Acme leaves a duplicate behind that changes what the test
covered.
"""

from __future__ import annotations

import pytest

from composer.protocol.models import ExistingRecord
from composer.solving.references import (
    MATCH_THRESHOLD,
    demands_novelty,
    label_field,
    match_phrase,
    records_of,
    taken_values,
)
from support.schemas import accounts

RECORDS = accounts()


def record(entity: str, ref: str, label: str | None, **fields: object) -> ExistingRecord:
    return ExistingRecord.model_validate(
        {"entity": entity, "externalRef": ref, "label": label, "fields": fields}
    )


# ── Scoping ───────────────────────────────────────────────────────────────────────────────────


def test_records_are_scoped_by_entity_case_insensitively() -> None:
    mixed = [*RECORDS, record("invoice", "INV-1", "Invoice one")]
    assert len(records_of(mixed, "Account")) == 3
    assert len(records_of(mixed, "Invoice")) == 1


def test_no_records_of_that_entity_means_no_match() -> None:
    assert match_phrase("acme", [], "Account") is None


# ── The four readings of a phrase ─────────────────────────────────────────────────────────────


def test_the_phrase_is_an_identifier_read_off_the_screen() -> None:
    match = match_phrase("ACC-1002", RECORDS, "Account")
    assert match is not None
    assert match.record.external_ref == "ACC-1002"
    assert match.score == 1.0


def test_the_phrase_and_the_label_are_the_same_words() -> None:
    match = match_phrase("Borealis Freight", RECORDS, "Account")
    assert match is not None
    assert match.record.external_ref == "ACC-1002"
    assert match.score == 1.0


def test_one_contains_the_other() -> None:
    """ "Acme" for "Acme Industrial Ltd" is right nearly always.

    Not scored 1.0, because it is wrong when the application also holds an "Acme Logistics" — and
    the preview shows the tester which one was chosen so they can catch that case.
    """
    match = match_phrase("Acme", RECORDS, "Account")
    assert match is not None
    assert match.record.external_ref == "ACC-1001"
    assert match.score == 0.9


def test_enough_words_overlap_to_be_the_same_name_said_loosely() -> None:
    # A tester who remembers the customer but not the suffix: "Acme Industrial Services" for
    # "Acme Industrial Ltd". Neither string contains the other, so this is the overlap reading.
    match = match_phrase("acme industrial services", RECORDS, "Account")
    assert match is not None
    assert match.record.external_ref == "ACC-1001"
    assert MATCH_THRESHOLD <= match.score < 0.9


def test_a_phrase_sharing_one_common_word_names_nothing() -> None:
    """Returning `None` rather than the best of a bad set is deliberate.

    The caller's response to no match is to create the record, which is recoverable. Pointing an
    order at the wrong customer is not, because nothing in the preview would look wrong.
    """
    pool = [record("Account", "ACC-1", "Northern Freight Holdings")]
    assert match_phrase("southern shipping company limited", pool, "Account") is None


def test_an_empty_phrase_names_nothing() -> None:
    assert match_phrase("   ", RECORDS, "Account") is None


def test_a_record_with_no_label_can_still_be_matched_by_identifier() -> None:
    pool = [record("Account", "ACC-9", None)]
    assert match_phrase("ACC-9", pool, "Account") is not None
    assert match_phrase("some name", pool, "Account") is None


def test_the_pool_size_is_carried_for_the_provenance() -> None:
    # "matched from 64 known accounts" is what makes the match believable rather than spooky.
    match = match_phrase("Acme", RECORDS, "Account")
    assert match is not None
    assert match.pool_size == 3


# ── Which field holds the name ────────────────────────────────────────────────────────────────


def test_the_label_field_is_discovered_from_the_records_themselves() -> None:
    """Discovered, never configured.

    Every supplied record carries both its fields and the label the application displays, so the
    field whose value *is* that label across most records is the display name — `name` in one
    application, `companyName` in the next. That is the whole reason this can be generic.
    """
    assert label_field(RECORDS, "Account") == "name"


def test_a_composed_label_has_no_field_behind_it() -> None:
    # "Acme Industrial (ACC-1001)" is not any one field's value, and the honest answer is None —
    # the caller refuses rather than creating a record with the name silently dropped.
    pool = [record("Account", "ACC-1", "Acme Industrial (ACC-1001)", name="Acme Industrial")]
    assert label_field(pool, "Account") is None


def test_one_coincidence_is_not_evidence() -> None:
    # A single record whose `notes` happens to repeat its own name does not make `notes` the
    # display field, so a majority is required.
    pool = [
        record("Account", "ACC-1", "Acme", name="Acme", notes="Acme"),
        record("Account", "ACC-2", "Borealis", name="Borealis", notes="ships weekly"),
        record("Account", "ACC-3", "Cormorant", name="Cormorant", notes="none"),
    ]
    assert label_field(pool, "Account") == "name"


def test_no_labelled_records_means_no_answer() -> None:
    assert label_field([record("Account", "ACC-1", None, name="Acme")], "Account") is None
    assert label_field([], "Account") is None


# ── Novelty ───────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "utterance",
    [
        "a new account",
        "a brand new account",
        "another account",
        "a different account",
        "a fresh account",
        "an additional account",
        "a second account",
    ],
)
def test_the_words_that_ask_for_a_record_that_does_not_exist_yet(utterance: str) -> None:
    assert demands_novelty(utterance, "Account")


def test_novelty_is_matched_adjacently_so_it_attaches_to_the_right_noun() -> None:
    """ "A new order for Acme Industrial" creates the order and reuses the account.

    Without the adjacency check the word "new" — which testers say about almost every seeding
    request — would force every reference in the sentence to be created too.
    """
    assert demands_novelty("a new order for Acme Industrial", "Order")
    assert not demands_novelty("a new order for Acme Industrial", "Account")


def test_a_new_customer_asks_for_both() -> None:
    assert demands_novelty("a new order for a new account", "Order")
    assert demands_novelty("a new order for a new account", "Account")


def test_no_novelty_marker_means_reuse() -> None:
    assert not demands_novelty("an order for Acme Industrial", "Account")


# ── Uniqueness ────────────────────────────────────────────────────────────────────────────────


def test_taken_values_are_read_from_the_supplied_records() -> None:
    """§ 3: "check for collision against observed values before returning".

    The only values the composer can check against are the ones in the request, which is why the
    gateway sends a sample rather than nothing.
    """
    assert taken_values(RECORDS, "Account", "name") == frozenset(
        {"Acme Industrial Ltd", "Borealis Freight", "Cormorant Analytics"}
    )


def test_taken_values_ignores_non_scalar_and_missing_values() -> None:
    pool = [
        record("Account", "ACC-1", "Acme", name="Acme", tags=["a", "b"]),
        record("Account", "ACC-2", "Borealis", tags=[]),
    ]
    assert taken_values(pool, "Account", "name") == frozenset({"Acme"})
    assert taken_values(pool, "Account", "tags") == frozenset()


def test_taken_values_of_an_entity_with_no_records_is_empty() -> None:
    assert taken_values(RECORDS, "Invoice", "reference") == frozenset()
