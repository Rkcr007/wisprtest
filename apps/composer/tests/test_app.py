import io
import json

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from starlette.routing import Route

from composer.app import create_app
from composer.config import load_config
from composer.logging import configure_logging
from composer.routes import create_router

VALID_ENV = {
    "NODE_ENV": "test",
    "LOG_LEVEL": "info",
    "COMPOSER_HOST": "127.0.0.1",
    "COMPOSER_PORT": "8090",
    # Phase 14 made the model provider and the composition budgets part of the contract with
    # the environment. Every one is required — CLAUDE.md rule #10: boot fails loudly on missing
    # config rather than defaulting.
    "MODEL_API_KEY": "sk-ant-test",
    "MODEL_BASE_URL": "https://api.anthropic.com",
    "MODEL_PRIMARY": "claude-haiku-4-5",
    "MODEL_FALLBACK": "claude-sonnet-5",
    "MODEL_TIMEOUT_MS": "800",
    "COMPOSE_BUDGET_MS": "1200",
    "COMPOSE_MIN_CONFIDENCE": "0.5",
}


def test_lifespan_logs_exactly_one_startup_and_one_shutdown_line() -> None:
    stream = io.StringIO()
    configure_logging(service="composer", env="test", level="info", stream=stream)

    with TestClient(create_app(load_config(VALID_ENV))):
        started = [json.loads(line) for line in stream.getvalue().splitlines()]
        assert len(started) == 1
        assert started[0]["event"] == "service.started"
        assert started[0]["port"] == 8090

    lines = [json.loads(line) for line in stream.getvalue().splitlines()]
    assert [line["event"] for line in lines] == ["service.started", "service.stopped"]


def test_registers_the_phase_14_routes_and_nothing_else() -> None:
    """Phase 0 shipped no endpoints; Phase 14 owns them, and there are exactly three.

    Asserted as an exact list rather than a membership check so a fourth route cannot appear
    without somebody deciding it should. The composer is an internal service with one job, and
    every endpoint on it is another thing the gateway can reach.

    Read off the router rather than off `app.routes`: FastAPI wraps an included router in an
    opaque dispatch object, and reaching into that would tie this assertion to a private
    attribute of the framework.
    """
    router = create_router(load_config(VALID_ENV))

    paths = sorted(route.path for route in router.routes if isinstance(route, APIRoute | Route))
    assert paths == ["/compose", "/healthz", "/readyz"]

    methods = {route.path: route.methods for route in router.routes if isinstance(route, APIRoute)}
    # Composing is a POST because it is a proposal built from a body, not an addressable
    # resource — and it must never be reachable by a method a browser can be tricked into.
    assert methods == {"/healthz": {"GET"}, "/readyz": {"GET"}, "/compose": {"POST"}}


def test_the_routes_are_reachable_once_mounted() -> None:
    app = create_app(load_config(VALID_ENV))

    with TestClient(app) as client:
        assert client.get("/healthz").json() == {"status": "ok"}
        assert client.get("/readyz").json() == {"status": "ready", "dependencies": []}
        # The path exists; only the verb is wrong. A 404 here would mean it was never mounted.
        assert client.get("/compose").status_code == 405


def test_exposes_no_openapi_schema() -> None:
    # The request and response shapes are defined in `packages/protocol`; a schema served from
    # here would be a second description of the contract that could drift from the first.
    app = create_app(load_config(VALID_ENV))

    with TestClient(app) as client:
        assert client.get("/openapi.json").status_code == 404
        assert client.get("/docs").status_code == 404
        assert client.get("/redoc").status_code == 404
