"""The FastAPI application.

No routes are registered. Phase 14 of docs/BUILD-PLAN.md owns the composer's endpoints, the
constraint parser, the solver, the value sampler and the provenance builder; Phase 0 is the
scaffold, and a placeholder route handler is exactly what CLAUDE.md rule #1 forbids.

The startup and shutdown lines are emitted from the lifespan rather than around
`uvicorn.run()`: on SIGTERM uvicorn restores the default signal disposition and re-raises the
signal at itself, so the process dies inside `run()` and anything written after it never
executes. The lifespan shutdown, by contrast, runs before that happens.
"""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from composer.config import ComposerConfig
from composer.logging import get_logger


def create_app(config: ComposerConfig) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        logger = get_logger()
        logger.info(
            "service.started",
            msg="composer started",
            host=config.composer_host,
            port=config.composer_port,
            pid=os.getpid(),
        )

        yield

        logger.info("service.stopped", msg="composer stopped")

    return FastAPI(
        title="WisprTest composer",
        version="0.0.0",
        lifespan=lifespan,
        # The composer is an internal service reached only by the gateway. Interactive docs are
        # enabled deliberately in Phase 14 if wanted, not by default.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
