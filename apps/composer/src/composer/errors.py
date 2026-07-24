"""Composer error taxonomy.

CLAUDE.md § "Conventions" requires a typed error taxonomy per service rather than bare
exceptions: every failure carries a stable machine-readable code so it can be mapped to a
response and counted in metrics without string matching. Phase 14 adds the constraint-conflict
and unsatisfiable-plan codes; this phase only needs what the bootstrap can raise.
"""

from typing import Literal

ComposerErrorCode = Literal["config_invalid", "startup_failed"]


class ComposerError(Exception):
    """Base class for every error this service raises deliberately."""

    def __init__(self, code: ComposerErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: ComposerErrorCode = code
        self.message: str = message


class ConfigError(ComposerError):
    """Raised when the environment does not satisfy the config schema.

    Carries every offending variable rather than only the first, so a misconfigured deployment
    is fixed in one pass.
    """

    def __init__(self, issues: list[str]) -> None:
        super().__init__("config_invalid", "invalid composer configuration: " + "; ".join(issues))
        self.issues: list[str] = issues
