"""Command and config assembly of the Harbor agent (no container needed)."""

from __future__ import annotations

import importlib.util
import json
import shlex
from pathlib import Path

import pytest

pytest.importorskip("harbor", reason="the agent module needs Harbor installed")

from openscience_harbor.agent import DEFAULT_CONFIG, OpenScienceAgent  # noqa: E402

HARBOR_MAIN = importlib.util.find_spec("harbor.agents.options") is not None


def agent(tmp_path: Path, **kwargs):
    return OpenScienceAgent(logs_dir=tmp_path, model_name="anthropic/claude-test", version="2.0.70", **kwargs)


def test_kwargs_become_cli_flags(tmp_path: Path) -> None:
    subject = agent(tmp_path, variant="high", effort="ultra", agent="research")
    flags = subject.build_cli_flags()
    assert "--variant high" in flags
    assert "--effort ultra" in flags
    assert "--agent research" in flags
    assert subject.name() == "openscience"
    assert subject.version() == "2.0.70"
    assert subject.get_version_command() == "$HOME/.openscience/bin/openscience --version"


def test_headless_config_and_env(tmp_path: Path) -> None:
    subject = agent(tmp_path, openscience_config={"experimental": {"continue_loop_on_deny": True}})
    config = subject.headless_config()
    assert config["sandbox"] == {"enabled": False}
    assert config["permission"] == DEFAULT_CONFIG["permission"]
    assert config["experimental"] == {"continue_loop_on_deny": True}
    provider = config["provider"]["anthropic"]
    assert provider["models"] == {"claude-test": {}}
    # A base URL from the host environment (ANTHROPIC_BASE_URL) is forwarded; otherwise none is written.
    base_url = subject.model_connection.configured_base_url
    assert provider.get("options", {}).get("baseURL") == base_url

    env = subject.run_env()
    logs = str(subject.environment_logs_dir)
    assert env["OPENSCIENCE_DATA_DIR"] == f"{logs}/openscience/data"
    assert env["OPENSCIENCE_CONFIG_DIR"] == f"{logs}/openscience/config"
    for key in (
        "OPENSCIENCE_DISABLE_AUTOUPDATE",
        "OPENSCIENCE_DISABLE_LSP_DOWNLOAD",
        "OPENSCIENCE_DISABLE_PROJECT_CONFIG",
        "OPENSCIENCE_SKIP_ENVIRONMENT_BOOTSTRAP",
    ):
        assert env[key] == "1"
    assert "OPENSCIENCE_FAKE_VCS" not in env

    setup = subject.setup_command()
    assert f"{logs}/openscience/config/openscience.json" in setup
    written = json.loads(shlex.split(setup.split(" && ")[1])[1])
    assert written == config


def test_unknown_kwargs_are_rejected_on_harbor_main(tmp_path: Path) -> None:
    if not HARBOR_MAIN:
        pytest.skip("Harbor 0.22 ignores undeclared kwargs")
    with pytest.raises(ValueError):
        agent(tmp_path, bogus=True)


def test_binary_kwarg_skips_the_download(tmp_path: Path) -> None:
    subject = agent(tmp_path, binary="/tmp/openscience")
    assert subject._binary == "/tmp/openscience"
