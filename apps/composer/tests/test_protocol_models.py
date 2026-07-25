"""Cross-language conformance for the generated protocol models.

`protocol_fixtures.json` is written by `pnpm --filter protocol gen:python` from the very same
fixtures that `packages/protocol`'s TypeScript suite parses. Validating them here is what makes
"Python and TypeScript cannot drift" an assertion rather than an intention: agreeing on a schema
is a weaker claim than agreeing on which payloads satisfy it.

Not asserted here: the cross-field rules on `ActionRequest` (only class R may be speculative;
classes C and S require confirmation). JSON Schema cannot express them, so they are enforced in
`packages/protocol/src/runtime.test.ts` on the TypeScript side, which is the only side that
constructs an ActionRequest.
"""

import enum
import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, RootModel, TypeAdapter, ValidationError

import composer.protocol.models as models

FIXTURES: dict[str, list[Any]] = json.loads(
    (Path(__file__).parent / "protocol_fixtures.json").read_text()
)

# Schemas the generator deliberately does not give a class of their own.
#
# Primitives are inlined into every field that uses them, so a hash arrives as a constrained
# `str` rather than something to unwrap. Discriminated unions are inlined for the same reason:
# `spec: MaterializerApi | MaterializerUi | MaterializerFixture` reads better than a root model
# whose `.root` has to be reached through. Both are covered through the models that carry them.
#
# The list is exhaustive and asserted, so a generator change that starts dropping classes shows
# up as a failure here rather than as silently reduced coverage.
INLINED_BY_DESIGN = {
    # Primitives.
    "Confidence",
    "IsoDateTime",
    "LatencyMs",
    "NonEmptyString",
    "Ordinal",
    "RedactedText",
    "RoutePath",
    "RoutePattern",
    "SampleSize",
    "Sha256Hex",
    "StructuralHash",
    "Uuid",
    # Discriminated unions, inlined at each use site as `Member | Member | …`.
    "ActionPayload",
    "Constraint",
    "DerivedRuleSpec",
    "DistributionShape",
    "InverseOperation",
    "MaterializerSpec",
    "NavPrecondition",
    "PredicateOperand",
    "QueryConstraint",
    "ResolutionResult",
}

# A schema arrives here as either a pydantic model or a StrEnum; `TypeAdapter` validates both.
Validatable = type[BaseModel] | type[enum.Enum]

# `StateFingerprint` and `ElementKey` survive as root models because they appear as list
# elements, where a constraint cannot be attached to the field.
VALIDATABLE: list[tuple[str, Validatable]] = sorted(
    (name, getattr(models, name))
    for name in FIXTURES
    if name not in INLINED_BY_DESIGN and hasattr(models, name)
)

IDS = [name for name, _ in VALIDATABLE]


def test_every_schema_either_has_a_model_or_is_inlined_on_purpose() -> None:
    unaccounted = {
        name for name in FIXTURES if name not in INLINED_BY_DESIGN and not hasattr(models, name)
    }
    assert unaccounted == set(), (
        f"{sorted(unaccounted)} generated no model and are not on the inlined-by-design list; "
        "the generator's output has changed"
    )

    stale = INLINED_BY_DESIGN - set(FIXTURES)
    assert stale == set(), f"{sorted(stale)} are listed as inlined but no longer exist"

    resurfaced = {name for name in INLINED_BY_DESIGN if hasattr(models, name)}
    assert resurfaced == set(), (
        f"{sorted(resurfaced)} now generate a class and should be validated rather than skipped"
    )


def test_fixture_file_covers_the_whole_contract() -> None:
    assert len(FIXTURES) >= 70, "the exported fixture set is smaller than the contract"
    assert all(payloads for payloads in FIXTURES.values()), "a schema was exported with no payload"


@pytest.mark.parametrize(("name", "model"), VALIDATABLE, ids=IDS)
def test_valid_typescript_fixtures_validate_in_python(name: str, model: Validatable) -> None:
    adapter: TypeAdapter[object] = TypeAdapter(model)
    for payload in FIXTURES[name]:
        adapter.validate_python(payload)


@pytest.mark.parametrize(("name", "model"), VALIDATABLE, ids=IDS)
def test_payloads_survive_a_round_trip_through_the_wire_form(name: str, model: Validatable) -> None:
    if not issubclass(model, BaseModel):
        pytest.skip(f"{name} is an enum; there is no wire form to re-serialise")

    for payload in FIXTURES[name]:
        parsed = model.model_validate(payload)
        # `by_alias` produces the camelCase wire form the TypeScript side sent. Re-validating it
        # must yield an equal model: anything else means the Python side is mutating payloads in
        # transit, which would corrupt every hop through the composer.
        assert model.model_validate(json.loads(parsed.model_dump_json(by_alias=True))) == parsed


def test_enums_carry_exactly_the_values_typescript_sends() -> None:
    tiers = {member.value for member in models.Tier}
    assert tiers == {"T0", "T1", "T2"}

    classes = {member.value for member in models.ActionClass}
    assert classes == {"R", "C", "A", "S"}

    # Every enum fixture value must be a member — the check the parametrised tests make per
    # schema, restated here so a reader can see what "conformance" means concretely.
    for name, model in VALIDATABLE:
        if issubclass(model, enum.Enum):
            values = {member.value for member in model}
            assert set(FIXTURES[name]) <= values


def test_unknown_keys_are_rejected_as_they_are_in_typescript() -> None:
    # The Zod schemas are strict; the generated models carry `extra='forbid'`. If these ever
    # diverge, a payload would parse on one side and fail on the other.
    payload = dict(FIXTURES["EvidenceRef"][0])
    payload["unexpected"] = "value"

    with pytest.raises(ValidationError):
        models.EvidenceRef.model_validate(payload)


def test_snake_case_and_wire_names_are_both_accepted() -> None:
    wire = FIXTURES["EvidenceRef"][0]
    by_alias = models.EvidenceRef.model_validate(wire)
    by_field = models.EvidenceRef(
        kind=wire["kind"],
        storage_key=wire["storageKey"],
        content_hash=wire["contentHash"],
        captured_at=wire["capturedAt"],
    )

    assert by_alias == by_field


def test_discriminated_unions_keep_their_members_distinct() -> None:
    # `InverseOperation` is the union the seed ledger depends on. A `none` inverse must not be
    # coerced into one of the actionable variants — the preview tells the tester a record cannot
    # be removed based on exactly this distinction.
    inverse_op = RootModel[
        models.InverseOperationApi
        | models.InverseOperationUi
        | models.InverseOperationFixture
        | models.InverseOperationNone
    ].model_validate({"kind": "none", "reason": "no delete flow exists"})

    assert isinstance(inverse_op.root, models.InverseOperationNone)
    assert inverse_op.root.reason == "no delete flow exists"


def test_constraints_are_enforced_not_merely_documented() -> None:
    valid = FIXTURES["ElementRecord"][0]

    with pytest.raises(ValidationError):
        models.ElementRecord.model_validate({**valid, "confidence": 1.4})

    with pytest.raises(ValidationError):
        models.ElementRecord.model_validate({**valid, "elementKey": "approve"})
