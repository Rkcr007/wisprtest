"""Composer error taxonomy.

CLAUDE.md § "Conventions" requires a typed error taxonomy per service rather than bare
exceptions: every failure carries a stable machine-readable code so it can be mapped to a
response and counted in metrics without string matching.

## What is deliberately *not* an error here

An unsatisfiable constraint set and a schema too uncertain to compose from are both **outcomes**,
not failures — they are `CompositionOutcome` variants carrying an explanation the tester reads.
docs/TEST-DATA-ENGINE.md § 7 requires the engine to "report the conflict in plain language" and
to "refuse with the specific missing field"; flattening either into an exception would reduce a
considered answer to a string. The codes below are for the cases where the composer genuinely
could not do its job.
"""

from typing import Literal

ComposerErrorCode = Literal[
    "config_invalid",
    "startup_failed",
    #: The utterance named an entity no supplied schema describes.
    "unknown_entity",
    #: The parser could not map the utterance to any constraint, at any tier.
    "unparsable_utterance",
    #: The model provider timed out, was unreachable, or answered unusably.
    "model_unavailable",
    #: Composition ran past its budget. Reported rather than returned late.
    "budget_exceeded",
]


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


class UnknownEntityError(ComposerError):
    """The utterance is about an entity none of the supplied schemas describes.

    Distinct from a refusal: a refusal means the schema is known but too thin to compose from,
    and names the missing fields. This means the engine has never heard of the thing at all,
    which is a different fix — index the application, or index more of it.
    """

    def __init__(self, entity: str, known: list[str]) -> None:
        super().__init__(
            "unknown_entity",
            f"no schema describes {entity!r}; this memory version knows: "
            f"{', '.join(known) or 'nothing'}",
        )
        self.entity: str = entity
        self.known: list[str] = known


class UnparsableUtteranceError(ComposerError):
    """Nothing in the utterance mapped to a constraint, at any tier.

    Reported rather than answered with an empty constraint set: composing from no constraints
    at all would produce a record the tester did not ask for, and § 7 forbids silently dropping
    what somebody said.
    """

    def __init__(self, utterance: str) -> None:
        super().__init__(
            "unparsable_utterance",
            "could not read any requirement from the utterance",
        )
        self.utterance: str = utterance


class ModelUnavailableError(ComposerError):
    """The escalation model timed out, was unreachable, or never produced a valid parse.

    Carries the reason but never the response body: a model reply is generated from the
    utterance and is not something to put in a log line unexamined.
    """

    def __init__(self, reason: str, model: str) -> None:
        super().__init__("model_unavailable", f"escalation failed on {model}: {reason}")
        self.reason: str = reason
        self.model: str = model


class BudgetExceededError(ComposerError):
    """Composition ran past its configured budget.

    Raised rather than returned late. A preview that arrives after the tester has moved on is
    worse than one that never arrives, because they have to decide whether to trust it.
    """

    def __init__(self, elapsed_ms: float, budget_ms: int) -> None:
        super().__init__(
            "budget_exceeded",
            f"composition took {elapsed_ms:.0f}ms against a {budget_ms}ms budget",
        )
        self.elapsed_ms: float = elapsed_ms
        self.budget_ms: int = budget_ms
