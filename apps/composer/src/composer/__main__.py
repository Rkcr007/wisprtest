"""Composer entrypoint.

Boots, logs one structured startup line, and exits cleanly on SIGTERM. uvicorn installs the
signal handlers and drains in-flight requests; the startup and shutdown lines are emitted from
the application lifespan (see app.py) because uvicorn does not return from `run()` when it is
stopped by a signal.
"""

import json
import sys

import uvicorn

from composer.app import create_app
from composer.config import load_config
from composer.errors import ConfigError
from composer.logging import configure_logging


def main() -> int:
    try:
        config = load_config()
    except ConfigError as exc:
        # Logging is not configured yet — a config failure has to report itself. Keep the shape
        # identical to a log line so whatever collects stderr needs no second parser.
        sys.stderr.write(
            json.dumps(
                {
                    "level": "fatal",
                    "service": "composer",
                    "event": "service.start_failed",
                    "code": exc.code,
                    "msg": exc.message,
                }
            )
            + "\n"
        )
        return 1

    configure_logging(service="composer", env=config.node_env, level=config.log_level)

    uvicorn.run(
        create_app(config),
        host=config.composer_host,
        port=config.composer_port,
        # structlog already owns stdout; uvicorn's own formatter would emit unstructured lines
        # alongside ours.
        log_config=None,
        access_log=False,
    )

    # Reached only when the server stops without a signal — a signal-triggered stop never
    # returns from run().
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
