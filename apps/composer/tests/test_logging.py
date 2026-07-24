import io
import json
import re

from structlog.typing import FilteringBoundLogger

from composer.logging import configure_logging, get_logger

ISO_8601_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


def _capture(level: str = "info") -> tuple[io.StringIO, FilteringBoundLogger]:
    stream = io.StringIO()
    configure_logging(service="composer", env="test", level=level, stream=stream)
    return stream, get_logger()


def test_emits_one_parseable_json_line_with_the_shared_shape() -> None:
    stream, logger = _capture()

    logger.info("service.started", msg="composer started", port=8090)

    lines = stream.getvalue().splitlines()
    assert len(lines) == 1

    line = json.loads(lines[0])
    assert line["service"] == "composer"
    assert line["env"] == "test"
    assert line["level"] == "info"
    assert line["event"] == "service.started"
    assert line["msg"] == "composer started"
    assert line["port"] == 8090


def test_timestamps_in_iso_8601_utc() -> None:
    stream, logger = _capture()

    logger.info("service.started", msg="composer started")

    line = json.loads(stream.getvalue().splitlines()[0])
    assert ISO_8601_UTC.match(line["time"])


def test_honours_the_configured_level() -> None:
    stream, logger = _capture(level="warn")

    logger.info("ignored", msg="below threshold")
    logger.warning("kept", msg="at threshold")

    lines = stream.getvalue().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["event"] == "kept"


def test_maps_pino_only_levels_onto_stdlib_numbers() -> None:
    stream, logger = _capture(level="trace")

    logger.debug("trace.enabled", msg="trace maps to debug")

    assert json.loads(stream.getvalue().splitlines()[0])["level"] == "debug"
