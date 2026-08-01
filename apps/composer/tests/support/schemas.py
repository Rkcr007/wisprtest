"""A learned Order schema, shaped like what the Phase 13 observers actually produce."""

from __future__ import annotations

from typing import Any

from composer.protocol.models import EntitySchema

UUID_A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
UUID_B = "9c5b94b1-35ad-49bb-b118-8e8fc24abf80"
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
                {
                    "id": UUID_A,
                    "entitySchemaId": UUID_B,
                    "spec": {
                        "kind": "ui",
                        "form": "orders-new.create-order",
                        "route": "/orders/new",
                    },
                    "priority": 2,
                    "verifiedAt": None,
                    "verificationTtlHours": 168,
                }
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
                        "rule": {"kind": "sum", "overField": "lines", "ofField": "amount"},
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
                    "lines",
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
                    "lines.amount",
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
