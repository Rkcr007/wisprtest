"""Composer configuration, read from the process environment and validated at boot.

Nothing here has a fallback. CLAUDE.md rule #10 requires boot to fail loudly on missing config
rather than defaulting.

The environment is read explicitly and validated with a plain pydantic model rather than via
BaseSettings' implicit lookup: it keeps `load_config` a pure function of its argument, which is
what makes the failure cases testable, and it mirrors how the Node services read `process.env`.
"""

import os
from collections.abc import Mapping
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from composer.errors import ConfigError

Environment = Literal["development", "test", "production"]
LogLevel = Literal["fatal", "error", "warn", "info", "debug", "trace"]


class ComposerConfig(BaseModel):
    """Validated composer settings. Every field is required by design."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    node_env: Environment = Field(validation_alias="NODE_ENV")
    log_level: LogLevel = Field(validation_alias="LOG_LEVEL")
    composer_host: str = Field(validation_alias="COMPOSER_HOST", min_length=1)
    composer_port: int = Field(validation_alias="COMPOSER_PORT", ge=1, le=65535)


def load_config(env: Mapping[str, str] | None = None) -> ComposerConfig:
    """Builds the config, or raises ConfigError naming every invalid variable."""
    source: Mapping[str, str] = os.environ if env is None else env

    try:
        return ComposerConfig.model_validate(dict(source))
    except ValidationError as exc:
        issues = [
            f"{'.'.join(str(part) for part in error['loc']) or '(root)'}: {error['msg']}"
            for error in exc.errors()
        ]
        raise ConfigError(issues) from exc
