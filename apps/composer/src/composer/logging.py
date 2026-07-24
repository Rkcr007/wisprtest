"""Structured JSON logging.

Emits the same line shape as the Node services' pino output — `level`, `time` (ISO 8601 UTC),
`service`, `env`, `event`, `msg` — so one log sink can query every service together.

Callers pass the semantic event name positionally and the human message as `msg`:

    logger.info("service.started", msg="composer started", port=8090)

CLAUDE.md § "Conventions" also requires `tenant_id`, `session_id` and `trace_id` on every line.
Those are request-scoped: Phase 14 binds them per request via `structlog.contextvars`, which the
processor chain below already merges. This phase has no request to scope them to.
"""

import logging
import sys
from typing import Final, TextIO, cast

import structlog
from structlog.typing import EventDict, FilteringBoundLogger, Processor, WrappedLogger

# Our level vocabulary is pino's, which has two levels the stdlib does not.
_LEVEL_NUMBERS: Final[dict[str, int]] = {
    "fatal": logging.CRITICAL,
    "error": logging.ERROR,
    "warn": logging.WARNING,
    "info": logging.INFO,
    "debug": logging.DEBUG,
    "trace": logging.DEBUG,
}


def _make_context_processor(service: str, env: str) -> Processor:
    def add_context(_logger: WrappedLogger, _name: str, event_dict: EventDict) -> EventDict:
        event_dict["service"] = service
        event_dict["env"] = env
        return event_dict

    return add_context


def build_processors(service: str, env: str) -> list[Processor]:
    return [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True, key="time"),
        _make_context_processor(service, env),
        structlog.processors.JSONRenderer(),
    ]


def configure_logging(service: str, env: str, level: str, stream: TextIO | None = None) -> None:
    """Installs the processor chain. Raises KeyError on an unknown level rather than guessing."""
    structlog.configure(
        processors=build_processors(service, env),
        wrapper_class=structlog.make_filtering_bound_logger(_LEVEL_NUMBERS[level]),
        logger_factory=structlog.WriteLoggerFactory(file=stream if stream else sys.stdout),
        cache_logger_on_first_use=False,
    )


def get_logger() -> FilteringBoundLogger:
    return cast(FilteringBoundLogger, structlog.get_logger())
