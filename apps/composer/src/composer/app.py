"""The FastAPI application.

Phase 14 gave the composer its routes: `POST /compose`, plus the liveness and readiness probes
CLAUDE.md rule #6 requires of every service. They live in `routes.py`; this module is the wiring —
telemetry started before the router is built, the router mounted, and the SDK flushed on shutdown.

The startup and shutdown lines are emitted from the lifespan rather than around `uvicorn.run()`:
on SIGTERM uvicorn restores the default signal disposition and re-raises the signal at itself, so
the process dies inside `run()` and anything written after it never executes. The lifespan
shutdown, by contrast, runs before that happens — which is also why the telemetry flush is there
and not in `__main__`, since an unflushed batch processor drops whatever it was holding.

## No OpenAPI, still

`docs_url`, `redoc_url` and `openapi_url` stay off. The composer is an internal service reached
only by the gateway, its request and response shapes are defined in `packages/protocol` rather
than here, and a generated schema served from this process would be a second description of the
contract that could drift from the first.
"""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from composer.config import ComposerConfig
from composer.logging import get_logger
from composer.routes import create_router
from composer.telemetry import start_telemetry


def create_app(config: ComposerConfig) -> FastAPI:
    telemetry = start_telemetry(env=config.node_env, endpoint=config.otel_exporter_otlp_endpoint)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        logger = get_logger()
        logger.info(
            "service.started",
            msg="composer started",
            host=config.composer_host,
            port=config.composer_port,
            pid=os.getpid(),
            telemetry_exporting=telemetry.exporting,
        )

        yield

        telemetry.shutdown()
        logger.info("service.stopped", msg="composer stopped")

    app = FastAPI(
        title="WisprTest composer",
        version="0.0.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.include_router(create_router(config))
    return app
