"""`POST /compose` over HTTP — the surface the gateway calls.

`test_composition.py` asserts what the composer concludes. This asserts what a caller *sees*, and
those are different contracts. Phase 15's gateway route reads status codes and a JSON body, so the
things pinned here are the ones it will branch on:

* **A conflict and a refusal are 200s.** They are answers — `errors.py` argues that at length —
  and a gateway that treated either as a failure would show the tester an error instead of the
  explanation written for them. This is the single most important assertion in the file.
* **Every error code has exactly one status.** The table in `routes.py` claims to be exhaustive
  over the taxonomy; here it is checked against the taxonomy rather than trusted.
* **The body is the contract's camelCase.** `packages/protocol` is the shared definition, and a
  response serialized in Python's snake_case would not validate against it.
* **No composed value reaches a log line.** § "PII rule" is a procurement blocker, and this
  endpoint handles a record built entirely out of the customer's own data.
"""

from __future__ import annotations

import io
import json
from typing import Any, get_args

import pytest
from fastapi.testclient import TestClient
from starlette.testclient import TestClient as StarletteTestClient

from composer.app import create_app
from composer.composition import compose
from composer.config import ComposerConfig, load_config
from composer.errors import BudgetExceededError, ComposerErrorCode
from composer.logging import configure_logging, get_logger
from composer.protocol.models import CompositionRequest
from composer.routes import STATUS_BY_CODE, _guard_budget
from support.schemas import (
    UUID_A,
    UUID_E,
    account_schema,
    accounts,
    invoice_schema,
    order_schema,
    request_body,
)

BASE_ENV = {
    "NODE_ENV": "test",
    "LOG_LEVEL": "info",
    "COMPOSER_HOST": "127.0.0.1",
    "COMPOSER_PORT": "8090",
    "MODEL_API_KEY": "k",
    "MODEL_BASE_URL": "https://api.anthropic.com",
    "MODEL_PRIMARY": "claude-haiku-4-5",
    "MODEL_FALLBACK": "claude-sonnet-4-5",
    "MODEL_TIMEOUT_MS": "800",
    "COMPOSE_BUDGET_MS": "1200",
    "COMPOSE_MIN_CONFIDENCE": "0.5",
}

WORKED_EXAMPLE = "i need a pending order for acme industrial with three line items"


def config(**overrides: str) -> ComposerConfig:
    return load_config({**BASE_ENV, **overrides})


def body(utterance: str, **overrides: Any) -> dict[str, Any]:  # noqa: ANN401
    overrides.setdefault("schemas", [order_schema(), account_schema(), invoice_schema()])
    return request_body(utterance, **overrides)


def client(**overrides: str) -> StarletteTestClient:
    return TestClient(create_app(config(**overrides)))


def captured() -> io.StringIO:
    """Point the shared logger at a buffer so the request's own lines can be read back."""
    stream = io.StringIO()
    configure_logging(service="composer", env="test", level="info", stream=stream)
    return stream


def lines(stream: io.StringIO) -> list[dict[str, Any]]:
    return [json.loads(line) for line in stream.getvalue().splitlines()]


def compose_line(stream: io.StringIO, event: str) -> dict[str, Any]:
    matching = [line for line in lines(stream) if line["event"] == event]
    assert len(matching) == 1, lines(stream)
    return matching[0]


# ── A plan ────────────────────────────────────────────────────────────────────────────────────


def test_a_composition_answers_200_in_the_contract_s_camel_case() -> None:
    """The response is validated back through the contract, not eyeballed key by key.

    Round-tripping it is what proves the gateway can parse what this endpoint sent: a body that
    serialized in snake_case would deserialize into nothing on the other side.
    """
    with client() as http:
        response = http.post("/compose", json=body(WORKED_EXAMPLE))

    assert response.status_code == 200
    payload = response.json()
    assert set(payload) == {"constraintSet", "outcome", "parseTier", "durationMs"}
    assert payload["outcome"]["kind"] == "planned"
    assert payload["parseTier"] == "T0"
    assert payload["durationMs"] > 0

    plan = payload["outcome"]["plan"]
    assert plan["tenantId"] == UUID_A
    assert plan["sessionId"] == UUID_E
    assert sorted(node["entity"] for node in plan["nodes"]) == ["Account", "Order"]
    assert plan["materializationOrder"][-1] == plan["rootNodeId"]


def test_the_endpoint_is_a_pure_function_of_its_body() -> None:
    """Nothing is read from a store and nothing is written to one, so the same request composes
    the same plan — including its identifier, which the gateway uses to match an approval back."""
    with client() as http:
        first = http.post("/compose", json=body(WORKED_EXAMPLE)).json()
        second = http.post("/compose", json=body(WORKED_EXAMPLE)).json()

    assert first["outcome"]["plan"] == second["outcome"]["plan"]


# ── Outcomes are 200s ─────────────────────────────────────────────────────────────────────────


def test_a_conflict_is_a_200_because_it_is_an_answer() -> None:
    """The tester gets the explanation written for them, not a status code.

    Phase 15's gateway branches on `outcome.kind`; if this were a 4xx it would branch on the
    status instead and the plain-language conflict would never reach the preview.
    """
    with client() as http:
        response = http.post("/compose", json=body("an order over 50000 and under 1000"))

    assert response.status_code == 200
    outcome = response.json()["outcome"]
    assert outcome["kind"] == "conflict"
    assert "no value satisfies both" in outcome["conflict"]["explanation"]


def test_a_refusal_is_a_200_because_it_is_an_answer() -> None:
    with client() as http:
        response = http.post(
            "/compose", json=body("an order for acme", schemas=[order_schema()], records=[])
        )

    assert response.status_code == 200
    outcome = response.json()["outcome"]
    assert outcome["kind"] == "refused"
    assert outcome["missingFields"] == ["accountId"]


# ── Failures ──────────────────────────────────────────────────────────────────────────────────


def test_an_entity_no_schema_describes_is_a_422_carrying_its_code() -> None:
    with client() as http:
        response = http.post(
            "/compose",
            json=body("i need a widget", schemas=[order_schema(), account_schema()], route="/home"),
        )

    assert response.status_code == 422
    assert response.json() == {
        "code": "unknown_entity",
        "message": (
            "no schema describes 'i need a widget'; this memory version knows: Order, Account"
        ),
    }


def test_an_utterance_nothing_could_be_read_out_of_is_a_422() -> None:
    with client() as http:
        response = http.post("/compose", json=body("an escalated order"))

    assert response.status_code == 422
    payload = response.json()
    assert payload["code"] == "unparsable_utterance"
    # § "PII rule": the utterance is the tester's own words about the customer's data, and this
    # message is written straight into a log line.
    assert "escalated" not in payload["message"]


def test_a_composition_past_its_budget_is_reported_rather_than_returned_late() -> None:
    """CLAUDE.md budgets the seed preview at 1.2 s p95; `errors.py` argues for reporting over
    returning late, because a preview that arrives after the tester has moved on makes them decide
    whether to trust it.

    Driven over the wire by a genuinely expensive composition — three thousand candidate accounts
    to match a phrase against — rather than by a patched clock, against a 1 ms budget it exceeds
    by roughly eight times. Nothing here waits on wall time: the work is real and the margin is
    the reason it does not flake.
    """
    with client(COMPOSE_BUDGET_MS="1") as http:
        response = http.post("/compose", json=body(WORKED_EXAMPLE, records=accounts(3000)))

    assert response.status_code == 504
    payload = response.json()
    assert payload["code"] == "budget_exceeded"
    assert "1ms budget" in payload["message"]


def test_a_body_that_is_not_a_composition_request_never_reaches_the_composer() -> None:
    """The contract is enforced at the edge. `packages/protocol` defines this shape, and a request
    missing half of it is rejected by the model rather than by something failing further in."""
    with client() as http:
        response = http.post("/compose", json={"utterance": "a pending order"})

    assert response.status_code == 422
    assert response.json()["detail"][0]["type"] == "missing"


@pytest.mark.parametrize("code", get_args(ComposerErrorCode))
def test_every_code_in_the_taxonomy_has_a_status(code: str) -> None:
    """The table in `routes.py` claims to be exhaustive so a new code fails to typecheck until it
    is given a status. Checked against the taxonomy here as well, because mypy proves the table has
    no *extra* keys but a caller still needs every code to answer with something sane."""
    assert STATUS_BY_CODE[code] in {422, 500, 503, 504}  # type: ignore[index]


def test_the_budget_guard_lets_a_composition_inside_the_budget_through() -> None:
    """The other half of the guard, asserted on a real response rather than a constructed one."""
    response = compose(CompositionRequest.model_validate(body(WORKED_EXAMPLE)), min_confidence=0.5)

    _guard_budget(response, config())

    over = response.model_copy(update={"duration_ms": 5_000.0})
    with pytest.raises(BudgetExceededError) as raised:
        _guard_budget(over, config())

    assert raised.value.elapsed_ms == 5_000.0
    assert raised.value.budget_ms == 1_200


# ── Logging ───────────────────────────────────────────────────────────────────────────────────


def test_the_completion_line_counts_the_plan_and_names_no_value_in_it() -> None:
    """§ "PII rule": structure, never content.

    The composed order carries a customer name, three line-item amounts and a total, all of them
    this application's own data. The assertion is that none of them appear anywhere in the line —
    checked against the values the composition actually produced, so it cannot pass by the record
    happening to be empty.
    """
    stream = captured()
    with client() as http:
        payload = http.post("/compose", json=body(WORKED_EXAMPLE)).json()

    line = compose_line(stream, "compose.completed")
    assert line["outcome"] == "planned"
    assert line["tier"] == "T0"
    assert line["nodes"] == 2
    assert line["edges"] == 1
    assert line["constraints"] == 3
    assert line["unparsed_fragments"] == 0
    assert line["duration_ms"] > 0

    rendered = json.dumps(line)
    values = [
        str(value)
        for node in payload["outcome"]["plan"]["nodes"]
        for value in node["fields"].values()
    ]
    assert values
    for value in values:
        assert value not in rendered


def test_every_line_carries_the_tenant_and_the_session() -> None:
    """CLAUDE.md § "Conventions". Without them a log sink holding every tenant's traffic cannot
    answer "what happened in this session"."""
    stream = captured()
    with client() as http:
        http.post("/compose", json=body(WORKED_EXAMPLE))

    line = compose_line(stream, "compose.completed")
    assert line["tenant_id"] == UUID_A
    assert line["session_id"] == UUID_E
    # No collector is configured in this suite, so there is no sampled span to take an id from.
    # The key is bound regardless, because a line that omits it and a line that carries `null`
    # look different to a query that filters on it.
    assert line["trace_id"] is None


def test_a_refusal_counts_the_missing_fields_rather_than_naming_them_by_value() -> None:
    stream = captured()
    with client() as http:
        http.post("/compose", json=body("an order for acme", schemas=[order_schema()], records=[]))

    line = compose_line(stream, "compose.completed")
    assert line["outcome"] == "refused"
    assert line["missing_fields"] == 1
    assert "nodes" not in line


def test_a_conflict_logs_neither_a_node_count_nor_a_missing_field_count() -> None:
    """There is no plan and nothing was refused, so a zero for either would be a number an
    operator could read as a fact about the composition."""
    stream = captured()
    with client() as http:
        http.post("/compose", json=body("an order over 50000 and under 1000"))

    line = compose_line(stream, "compose.completed")
    assert line["outcome"] == "conflict"
    assert "nodes" not in line
    assert "missing_fields" not in line


def test_a_failure_is_logged_at_warn_with_its_code_and_the_route_it_came_from() -> None:
    stream = captured()
    with client() as http:
        http.post("/compose", json=body("an escalated order"))

    line = compose_line(stream, "compose.failed")
    assert line["level"] == "warning"
    assert line["code"] == "unparsable_utterance"
    assert line["route"] == "/compose"
    assert line["duration_ms"] >= 0
    assert line["tenant_id"] == UUID_A


def test_one_request_s_context_never_leaks_into_the_next_line() -> None:
    """The bindings are cleared in a `finally`, so a failed request cannot leave its tenant id
    attached to whatever the process logs afterwards — which in a multi-tenant service would put
    one customer's identifier on another customer's line.
    """
    stream = captured()
    with client() as http:
        http.post("/compose", json=body("an escalated order"))

    get_logger().info("unrelated", msg="after the request")

    line = compose_line(stream, "unrelated")
    assert "tenant_id" not in line
    assert "session_id" not in line
