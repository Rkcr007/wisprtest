"""Learned schemas shaped like what the Phase 13 observers actually produce.

Three of them: an `Order` that exercises every field type the sampler and the derived-rule
evaluator know about, and an `Account`/`Invoice` pair that exists for exactly one sentence —
docs/TEST-DATA-ENGINE.md § 3's "give me a customer with an overdue invoice", the worked example
for predicates and multi-entity graphs.

Everything here is *data*, which is the point. Not a line of the composer knows these entities
exist; they arrive in a request like any customer's would, and a test that passes against them is
evidence the engine is generic rather than evidence it was written around this fixture.
"""

from __future__ import annotations

from typing import Any

from composer.protocol.models import ConstraintAlias, EntitySchema, ExistingRecord, RuntimeState

UUID_A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
UUID_B = "9c5b94b1-35ad-49bb-b118-8e8fc24abf80"
UUID_C = "1b4e28ba-2fa1-11d2-883f-0016d3cca427"
UUID_D = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
UUID_E = "6ba7b811-9dad-11d1-80b4-00c04fd430c8"
NOW = "2026-08-01T09:00:00Z"


def _field(name: str, type_: str, **overrides: Any) -> dict[str, Any]:  # noqa: ANN401
    base: dict[str, Any] = {
        "id": UUID_A,
        "entitySchemaId": UUID_B,
        "name": name,
        "type": type_,
        "required": False,
        "derivedRule": None,
        "enumValues": None,
        "distribution": None,
        "referencesEntity": None,
        "valueConstraints": {
            "min": None,
            "max": None,
            "minLength": None,
            "maxLength": None,
            "pattern": None,
        },
        "controlElementKey": None,
        "unique": False,
    }
    base.update(overrides)
    return base


def _ui_materializer(schema_id: str, form: str, route: str) -> dict[str, Any]:
    return {
        "id": UUID_A,
        "entitySchemaId": schema_id,
        "spec": {"kind": "ui", "form": form, "route": route},
        "priority": 2,
        "verifiedAt": None,
        "verificationTtlHours": 168,
    }


def order_schema() -> EntitySchema:
    return EntitySchema.model_validate(
        {
            "id": UUID_B,
            "memoryVersionId": UUID_A,
            "entityName": "Order",
            "observedCount": 50,
            "confidence": 0.92,
            "createdAt": NOW,
            "predicates": [
                {
                    "name": "overdue",
                    "entity": "Order",
                    "clauses": [
                        {"field": "dueAt", "op": "lt", "operand": {"kind": "now", "offsetDays": 0}},
                        {
                            "field": "status",
                            "op": "neq",
                            "operand": {"kind": "literal", "value": "shipped"},
                        },
                    ],
                    "source": "inferred",
                    "confidence": 0.9,
                    "sampleSize": 50,
                }
            ],
            "materializers": [
                _ui_materializer(UUID_B, "orders-new.create-order", "/orders/new")
            ],
            "fields": [
                _field(
                    "customer",
                    "string",
                    required=True,
                    distribution={
                        "shape": {
                            "kind": "string_pattern",
                            "prefix": None,
                            "minLength": 14,
                            "maxLength": 25,
                            "charset": "mixed",
                        },
                        "sampleSize": 50,
                        "distinctCount": 50,
                    },
                ),
                _field("accountId", "reference", referencesEntity="Account", required=True),
                _field(
                    "status",
                    "enum",
                    enumValues=["approved", "cancelled", "pending", "shipped"],
                    distribution={
                        "shape": {
                            "kind": "categorical",
                            "frequencies": {
                                "pending": 0.26,
                                "approved": 0.26,
                                "shipped": 0.24,
                                "cancelled": 0.24,
                            },
                        },
                        "sampleSize": 50,
                        "distinctCount": 4,
                    },
                ),
                _field(
                    "terms",
                    "enum",
                    enumValues=["net15", "net30", "net60"],
                    distribution={
                        "shape": {
                            "kind": "categorical",
                            "frequencies": {"net15": 0.34, "net30": 0.34, "net60": 0.32},
                        },
                        "sampleSize": 50,
                        "distinctCount": 3,
                    },
                ),
                _field(
                    "amount",
                    "number",
                    required=True,
                    derivedRule={
                        "rule": {"kind": "sum", "overField": "lineItems", "ofField": "amount"},
                        "confidence": 1.0,
                        "sampleSize": 50,
                    },
                    distribution={
                        "shape": {
                            "kind": "numeric",
                            "min": 69.04,
                            "max": 11008.0,
                            "mean": 3176.78,
                            "stddev": 2604.43,
                            "fit": "unknown",
                        },
                        "sampleSize": 50,
                        "distinctCount": 50,
                    },
                ),
                _field(
                    "reference",
                    "string",
                    unique=True,
                    distribution={
                        "shape": {
                            "kind": "string_pattern",
                            "prefix": "ORD-",
                            "minLength": 8,
                            "maxLength": 8,
                            "charset": "numeric",
                        },
                        "sampleSize": 50,
                        "distinctCount": 50,
                    },
                ),
                _field(
                    "dueAt",
                    "datetime",
                    distribution={
                        "shape": {
                            "kind": "temporal",
                            "minOffsetDays": -147.0,
                            "maxOffsetDays": -0.7,
                        },
                        "sampleSize": 50,
                        "distinctCount": 50,
                    },
                ),
                _field(
                    "lineItems",
                    "group",
                    distribution={
                        "shape": {
                            "kind": "numeric",
                            "min": 1,
                            "max": 5,
                            "mean": 3.08,
                            "stddev": 1.4,
                            "fit": "normal",
                        },
                        "sampleSize": 50,
                        "distinctCount": 5,
                    },
                ),
                _field(
                    "lineItems.amount",
                    "number",
                    distribution={
                        "shape": {
                            "kind": "numeric",
                            "min": 67.55,
                            "max": 3893.33,
                            "mean": 1031.42,
                            "stddev": 1092.02,
                            "fit": "lognormal",
                        },
                        "sampleSize": 154,
                        "distinctCount": 154,
                    },
                ),
            ],
        }
    )


def account_schema() -> EntitySchema:
    """The head noun of § 3's worked example. Carries no predicates of its own."""
    return EntitySchema.model_validate(
        {
            "id": UUID_C,
            "memoryVersionId": UUID_A,
            "entityName": "Account",
            "observedCount": 64,
            "confidence": 0.88,
            "createdAt": NOW,
            "predicates": [],
            "materializers": [
                _ui_materializer(UUID_C, "accounts-new.create-account", "/accounts/new")
            ],
            "fields": [
                _field(
                    "name",
                    "string",
                    entitySchemaId=UUID_C,
                    required=True,
                    distribution={
                        "shape": {
                            "kind": "string_pattern",
                            "prefix": None,
                            "minLength": 8,
                            "maxLength": 18,
                            "charset": "alpha",
                        },
                        "sampleSize": 64,
                        "distinctCount": 64,
                    },
                ),
                _field(
                    "tier",
                    "enum",
                    entitySchemaId=UUID_C,
                    enumValues=["bronze", "silver", "gold"],
                    distribution={
                        "shape": {
                            "kind": "categorical",
                            "frequencies": {"bronze": 0.5, "silver": 0.35, "gold": 0.15},
                        },
                        "sampleSize": 64,
                        "distinctCount": 3,
                    },
                ),
            ],
        }
    )


def invoice_schema() -> EntitySchema:
    """Where `overdue` is learned. Points back at `Account`, which is the edge the solver walks."""
    return EntitySchema.model_validate(
        {
            "id": UUID_D,
            "memoryVersionId": UUID_A,
            "entityName": "Invoice",
            "observedCount": 210,
            "confidence": 0.9,
            "createdAt": NOW,
            "predicates": [
                {
                    "name": "overdue",
                    "entity": "Invoice",
                    "clauses": [
                        {"field": "dueAt", "op": "lt", "operand": {"kind": "now", "offsetDays": 0}},
                        {
                            "field": "status",
                            "op": "neq",
                            "operand": {"kind": "literal", "value": "paid"},
                        },
                    ],
                    "source": "inferred",
                    "confidence": 0.94,
                    "sampleSize": 210,
                }
            ],
            "materializers": [
                _ui_materializer(UUID_D, "invoices-new.create-invoice", "/invoices/new")
            ],
            "fields": [
                _field(
                    "accountId",
                    "reference",
                    entitySchemaId=UUID_D,
                    required=True,
                    referencesEntity="Account",
                ),
                _field(
                    "status",
                    "enum",
                    entitySchemaId=UUID_D,
                    required=True,
                    enumValues=["draft", "sent", "paid"],
                    distribution={
                        "shape": {
                            "kind": "categorical",
                            "frequencies": {"draft": 0.2, "sent": 0.35, "paid": 0.45},
                        },
                        "sampleSize": 210,
                        "distinctCount": 3,
                    },
                ),
                _field(
                    "total",
                    "currency",
                    entitySchemaId=UUID_D,
                    required=True,
                    distribution={
                        "shape": {
                            "kind": "numeric",
                            "min": 120.0,
                            "max": 48000.0,
                            "mean": 6400.0,
                            "stddev": 5100.0,
                            "fit": "lognormal",
                        },
                        "sampleSize": 210,
                        "distinctCount": 205,
                    },
                ),
                _field(
                    "dueAt",
                    "datetime",
                    entitySchemaId=UUID_D,
                    distribution={
                        "shape": {
                            "kind": "temporal",
                            "minOffsetDays": -90.0,
                            "maxOffsetDays": 45.0,
                        },
                        "sampleSize": 210,
                        "distinctCount": 208,
                    },
                ),
            ],
        }
    )


def accounts(count: int = 3) -> list[ExistingRecord]:
    """Real records the gateway sends along, for reference resolution to work against."""
    names = ["Acme Industrial Ltd", "Borealis Freight", "Cormorant Analytics"]
    return [
        ExistingRecord.model_validate(
            {
                "entity": "Account",
                "externalRef": f"ACC-{1001 + index}",
                "label": names[index % len(names)],
                "fields": {"name": names[index % len(names)], "tier": "bronze"},
            }
        )
        for index in range(count)
    ]


def runtime_state(route: str = "/orders") -> RuntimeState:
    """Where the tester is. Only `routePattern` matters to the composer — it is what scopes an
    unqualified utterance to an entity — but the contract's shape is honoured in full so the
    fixture is a real request rather than the subset this service happens to read."""
    return RuntimeState.model_validate(
        {
            "route": route,
            "routePattern": route,
            "modalStack": [],
            "focusedLandmark": None,
            "visibleElementKeys": [],
            "structuralHash": "b" * 64,
            "stateFingerprint": "c" * 64,
            "capturedAt": NOW,
        }
    )


def request_body(
    utterance: str,
    *,
    schemas: list[EntitySchema] | None = None,
    records: list[ExistingRecord] | None = None,
    aliases: list[ConstraintAlias] | None = None,
    route: str = "/orders",
    seed: int | None = 7,
    now: str = NOW,
) -> dict[str, Any]:
    """A `CompositionRequest` as JSON, in the contract's camelCase."""
    return {
        "tenantId": UUID_A,
        "sessionId": UUID_E,
        "memoryVersionId": UUID_B,
        "utterance": utterance,
        "schemas": [
            schema.model_dump(mode="json", by_alias=True)
            for schema in (schemas if schemas is not None else [order_schema()])
        ],
        "runtimeState": runtime_state(route).model_dump(mode="json", by_alias=True),
        "existingRecords": [
            record.model_dump(mode="json", by_alias=True)
            for record in (records if records is not None else accounts())
        ],
        "aliases": [
            alias.model_dump(mode="json", by_alias=True) for alias in (aliases or [])
        ],
        "now": now,
        "seed": seed,
    }
