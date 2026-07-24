import pytest

from composer.config import load_config
from composer.errors import ConfigError

VALID_ENV = {
    "NODE_ENV": "development",
    "LOG_LEVEL": "info",
    "COMPOSER_HOST": "127.0.0.1",
    "COMPOSER_PORT": "8090",
}


def test_parses_a_complete_environment_and_coerces_the_port() -> None:
    config = load_config(VALID_ENV)

    assert config.composer_host == "127.0.0.1"
    assert config.composer_port == 8090
    assert config.node_env == "development"


def test_names_every_missing_variable_not_just_the_first() -> None:
    partial = {"NODE_ENV": "development", "LOG_LEVEL": "info"}

    with pytest.raises(ConfigError) as excinfo:
        load_config(partial)

    issues = "\n".join(excinfo.value.issues)
    assert "COMPOSER_HOST" in issues
    assert "COMPOSER_PORT" in issues


def test_rejects_a_non_numeric_port_rather_than_defaulting() -> None:
    with pytest.raises(ConfigError):
        load_config({**VALID_ENV, "COMPOSER_PORT": "not-a-port"})


def test_rejects_a_port_outside_the_valid_range() -> None:
    with pytest.raises(ConfigError):
        load_config({**VALID_ENV, "COMPOSER_PORT": "70000"})


def test_rejects_an_unknown_environment_name() -> None:
    with pytest.raises(ConfigError):
        load_config({**VALID_ENV, "NODE_ENV": "staging"})


def test_rejects_an_empty_host() -> None:
    with pytest.raises(ConfigError):
        load_config({**VALID_ENV, "COMPOSER_HOST": ""})


def test_config_is_immutable() -> None:
    config = load_config(VALID_ENV)

    with pytest.raises(ValueError, match="frozen"):
        config.composer_port = 9999
