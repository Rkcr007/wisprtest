import io
import json

from fastapi.testclient import TestClient

from composer.app import create_app
from composer.config import load_config
from composer.logging import configure_logging

VALID_ENV = {
    "NODE_ENV": "test",
    "LOG_LEVEL": "info",
    "COMPOSER_HOST": "127.0.0.1",
    "COMPOSER_PORT": "8090",
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


def test_registers_no_routes_and_exposes_no_schema() -> None:
    app = create_app(load_config(VALID_ENV))

    # Phase 0 ships no endpoints. Only Starlette's own default routes are present.
    assert [route.path for route in app.routes] == []  # type: ignore[attr-defined]

    with TestClient(app) as client:
        assert client.get("/openapi.json").status_code == 404
