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

    # ── The model provider ────────────────────────────────────────────────────────────────
    # The same four settings the gateway reads for T2 escalation, under the same names, because
    # it is the same provider and the same account. A second set of names would let the two
    # services drift onto different models without anyone noticing.
    model_api_key: str = Field(validation_alias="MODEL_API_KEY", min_length=1)
    model_base_url: str = Field(validation_alias="MODEL_BASE_URL", min_length=1)
    model_primary: str = Field(validation_alias="MODEL_PRIMARY", min_length=1)
    model_fallback: str = Field(validation_alias="MODEL_FALLBACK", min_length=1)
    #: Ceiling on one model call. CLAUDE.md § "Resolution tiers" budgets T2 at 800 ms.
    model_timeout_ms: int = Field(validation_alias="MODEL_TIMEOUT_MS", ge=1, le=5_000)

    # ── Composition ───────────────────────────────────────────────────────────────────────
    #: End-to-end budget for one composition. CLAUDE.md budgets the preview at 1.2 s p95.
    compose_budget_ms: int = Field(validation_alias="COMPOSE_BUDGET_MS", ge=1, le=30_000)
    #: Below this, an entity schema is too uncertain to compose from; the composer refuses
    #: and names the fields it cannot fill (docs/TEST-DATA-ENGINE.md § 7).
    compose_min_confidence: float = Field(validation_alias="COMPOSE_MIN_CONFIDENCE", ge=0.0, le=1.0)

    # ── Observability ─────────────────────────────────────────────────────────────────────
    #: OTLP collector base URL, e.g. `http://localhost:4318`. The one optional setting in this
    #: model, and deliberately so: unset means spans and measurements are still created but not
    #: exported, which is the right local default because the compose stack carries no collector.
    #: That is not the defaulting rule #10 forbids — rule #10 is about values the service cannot
    #: run correctly without, and there is no correct value to guess for an absent collector.
    #: The service *name* is not read from here; see `telemetry.SERVICE_NAME` for why.
    otel_exporter_otlp_endpoint: str | None = Field(
        validation_alias="OTEL_EXPORTER_OTLP_ENDPOINT", default=None
    )


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
