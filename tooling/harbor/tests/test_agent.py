"""Real Harbor 0.22 API with a local, deterministic environment transport.

The fixture executable only emits recorded events. No model, container runtime,
installer download, verifier, or benchmark job is started by these tests.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import json
import os
import shlex
import shutil
import sys
from pathlib import Path, PurePosixPath

import pytest
from harbor.agents.installed.base import BaseInstalledAgent, NonZeroAgentExitCodeError
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory
from openscience_harbor import agent as module
from openscience_harbor.agent import DEFAULT_CONFIG, OpenScienceAgent

FIXTURE = Path(__file__).parent / "fixtures" / "openscience.jsonl"
DELEGATION = Path(__file__).parent / "fixtures" / "delegation.jsonl"


def agent(tmp_path: Path, **kwargs):
    return OpenScienceAgent(
        logs_dir=tmp_path,
        model_name="anthropic/claude-test",
        version="2.0.70",
        **kwargs,
    )


class LocalEnvironment:
    """Exercise Harbor's actual exec helpers, with isolated host/remote logs."""

    def __init__(self, root: Path):
        self.home = root / "home"
        self.cwd = root / "native-workdir"
        self.home.mkdir()
        self.cwd.mkdir()
        self.calls: list[dict] = []
        self.downloads: list[tuple[str, Path]] = []

    async def exec(self, *, command, user=None, env=None, cwd=None, timeout_sec=None):
        self.calls.append({"command": command, "user": user, "cwd": cwd, "env": env})
        process = await asyncio.create_subprocess_exec(
            "bash",
            "-c",
            command,
            cwd=cwd or self.cwd,
            env={"PATH": os.environ["PATH"], "HOME": str(self.home), **(env or {})},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        return ExecResult(
            return_code=process.returncode,
            stdout=stdout.decode(),
            stderr=stderr.decode(),
        )

    async def upload_file(self, source_path, target_path):
        Path(target_path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, target_path)

    async def download_file(self, source_path, target_path):
        self.downloads.append((source_path, target_path))
        shutil.copy2(source_path, target_path)


def local_agent(
    tmp_path,
    monkeypatch,
    *,
    events=None,
    process_exit=0,
    reported_version="2.0.70",
    supports_workspace=True,
    **kwargs,
):
    remote_logs = tmp_path / "remote-logs"
    host_logs = tmp_path / "host-logs"
    remote_logs.mkdir()
    host_logs.mkdir()
    binary = tmp_path / "fixture-agent"
    stream = FIXTURE.read_text() if events is None else events
    binary.write_text(
        f"#!{sys.executable}\n"
        "import json, pathlib, sys\n"
        "if '--version' in sys.argv:\n"
        f"    print({reported_version!r})\n"
        "    raise SystemExit(0)\n"
        "if '--help' in sys.argv:\n"
        f"    print({'--workspace project|isolated' if supports_workspace else 'run help without workspace selection'!r})\n"
        "    raise SystemExit(0)\n"
        "pathlib.Path('invocation.json').write_text(json.dumps(sys.argv[1:]))\n"
        f"print({stream!r}, end='')\n"
        f"raise SystemExit({process_exit})\n"
    )
    binary.chmod(0o755)
    monkeypatch.setattr(
        module, "UPLOADED_BINARY", str(tmp_path / "installed-agent" / "openscience")
    )
    environment = LocalEnvironment(tmp_path)
    subject = agent(
        host_logs,
        binary=str(binary),
        environment_logs_dir=PurePosixPath(remote_logs),
        **kwargs,
    )
    return subject, environment


def test_real_harbor_contract(tmp_path):
    assert importlib.metadata.version("harbor") == "0.22.0"
    subject = agent(tmp_path, variant="high", effort="ultra", agent="research")
    assert isinstance(subject, BaseInstalledAgent)
    assert subject.SUPPORTS_ATIF and subject.SUPPORTS_RESUME
    assert not subject.SUPPORTS_LOAD_ATIF_TRAJECTORY
    assert subject.build_cli_flags() == "--variant high --effort ultra --agent research"
    with pytest.raises(ValueError):
        agent(tmp_path, effort="bogus")


def test_delegation_flags_are_validated_and_rendered(tmp_path):
    subject = agent(
        tmp_path,
        delegation="standard",
        worker_model="openrouter/anthropic/claude-sonnet-4.5:beta",
        autonomy="autonomous",
        deadline=1800,
    )
    assert subject.build_cli_flags() == (
        "--delegation standard --worker-model openrouter/anthropic/claude-sonnet-4.5:beta "
        "--autonomy autonomous --deadline 1800"
    )
    # Harbor's --ak parser yields JSON scalars; a numeric string still works
    # and a float budget is whole seconds.
    assert "--deadline 90" in agent(tmp_path, deadline="90").build_cli_flags()
    assert "--deadline 90" in agent(tmp_path, deadline=90.0).build_cli_flags()
    assert "--delegation off" in agent(tmp_path, delegation="OFF").build_cli_flags()
    assert agent(tmp_path, delegation=None, deadline=None).build_cli_flags() == ""


@pytest.mark.parametrize(
    "kwargs",
    [
        {"delegation": "medium"},
        {"delegation": True},
        {"autonomy": "manual"},
        {"worker_model": "claude-test"},
        {"worker_model": "anthropic/claude test; rm -rf /"},
        {"worker_model": 7},
        {"deadline": 0},
        {"deadline": -30},
        {"deadline": "soon"},
        {"deadline": 1.5},
        {"deadline": True},
    ],
)
def test_invalid_delegation_flags_fail_before_setup(tmp_path, kwargs):
    with pytest.raises(ValueError):
        agent(tmp_path, **kwargs)


def test_headless_config_and_env(tmp_path):
    subject = agent(tmp_path)
    config = subject.headless_config()
    assert config["sandbox"] == {"enabled": False}
    assert config["agent"]["title"]["disable"] is True
    assert config["permission"] == DEFAULT_CONFIG["permission"]
    # Local compute_job targets run in the container; remote backends and
    # account-dependent tools stay denied, and a denied call no longer ends
    # the run.
    assert "compute_job" not in config["permission"]
    assert config["permission"]["*"] == "allow"
    assert all(
        config["permission"][tool] == "deny"
        for tool in (
            "remote_compute",
            "modal",
            "provider_compute",
            "research_search",
            "atlas",
            "atlas_write",
        )
    )
    assert config["experimental"] == {"continue_loop_on_deny": True}
    overlay = agent(
        tmp_path, openscience_config={"experimental": {"primary_tools": ["bash"]}}
    ).headless_config()
    assert overlay["experimental"] == {
        "continue_loop_on_deny": True,
        "primary_tools": ["bash"],
    }
    assert config["provider"]["anthropic"]["models"] == {"claude-test": {}}
    env = subject.run_env()
    assert (
        env["OPENSCIENCE_DATA_DIR"]
        == str(subject.environment_logs_dir) + "/openscience/data"
    )
    assert all(env[key] == "1" for key in module.HEADLESS_ENV)
    assert "OPENSCIENCE_DISABLE_BUNDLED_SKILLS" not in env
    assert "OPENSCIENCE_FAKE_VCS" not in env
    assert "JUDGE_API_KEY" not in env


def test_skills_none_disables_bundled_catalog(tmp_path):
    subject = agent(tmp_path, skills="none")
    assert subject.run_env()["OPENSCIENCE_DISABLE_BUNDLED_SKILLS"] == "1"
    with pytest.raises(ValueError, match="bundled or none"):
        agent(tmp_path, skills="core")


def test_trusted_title_override_does_not_mutate_headless_defaults(tmp_path):
    subject = agent(
        tmp_path, openscience_config={"agent": {"title": {"disable": False}}}
    )
    config = subject.headless_config()
    assert config["agent"]["title"]["disable"] is False
    config["agent"]["title"]["disable"] = True
    assert subject.headless_config()["agent"]["title"]["disable"] is False
    assert agent(tmp_path).headless_config()["agent"]["title"]["disable"] is True


@pytest.mark.parametrize(
    "kwargs",
    [
        {},
        {"version": "latest"},
        {"version": "../../main"},
        {"version": "2.0.70", "cwd": "relative"},
        {"version": "2.0.70", "binary_sha256": "f" * 64},
        {"version": "2.0.70", "skills": "core"},
    ],
)
def test_invalid_identity_and_cwd_fail_before_setup(tmp_path, kwargs):
    with pytest.raises(ValueError):
        OpenScienceAgent(
            logs_dir=tmp_path, model_name="anthropic/claude-test", **kwargs
        )


def test_local_binary_digest_pin(tmp_path):
    binary = tmp_path / "binary"
    binary.write_bytes(b"immutable fixture")
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    assert (
        agent(tmp_path, binary=str(binary), binary_sha256=digest)._binary_digest
        == digest
    )
    with pytest.raises(ValueError, match="does not match"):
        agent(tmp_path, binary=str(binary), binary_sha256="0" * 64)


def test_native_workdir_remote_log_and_identity(tmp_path, monkeypatch):
    subject, environment = local_agent(tmp_path, monkeypatch)
    secret = tmp_path / "verifier-only.txt"
    secret.write_text("not an agent input")
    context = AgentContext()
    asyncio.run(subject.install(environment))
    instruction = "Read notes.txt; literal $(never-execute) and 'quotes'"
    asyncio.run(subject.run(instruction, environment, context))
    invocation = json.loads((environment.cwd / "invocation.json").read_text())
    assert invocation[-2:] == ["--", instruction]
    assert invocation[invocation.index("--workspace") + 1] == "project"
    assert context.is_empty()  # Harbor must still invoke post-run population.
    run = next(
        call for call in environment.calls if "openscience run" in call["command"]
    )
    assert run["cwd"] is None and run["user"] is None
    assert run["command"].startswith("set -o pipefail;")
    assert environment.downloads and (subject.logs_dir / "openscience.txt").is_file()
    subject.populate_context_post_run(context)
    result = Trajectory.model_validate_json(
        (subject.logs_dir / "trajectory.json").read_text()
    )
    assert context.n_input_tokens == 280
    assert context.n_output_tokens == 27
    assert context.n_cache_tokens == 0
    assert context.cost_usd == 0
    assert result.extra["binary"]["installed_version"] == "2.0.70"
    assert result.extra["binary"]["sha256"] == subject._binary_digest
    assert result.extra["binary"]["skills"] == "bundled"
    assert secret.read_text() == "not an agent input"
    assert all("verifier-only" not in call["command"] for call in environment.calls)


def test_delegated_run_writes_child_trajectories_and_counts_their_usage(
    tmp_path, monkeypatch
):
    subject, environment = local_agent(
        tmp_path,
        monkeypatch,
        events=DELEGATION.read_text(),
        delegation="light",
        worker_model="stress/worker-model",
        autonomy="balanced",
        deadline=600,
    )
    asyncio.run(subject.install(environment))
    identity = subject._identity
    assert identity["skills"] == "bundled"
    assert identity["delegation"] == "light"
    assert identity["worker_model"] == "stress/worker-model"
    assert identity["autonomy"] == "balanced"
    assert identity["deadline"] == 600
    assert (
        json.loads((Path(subject._logs) / "openscience-identity.json").read_text())
        == identity
    )
    context = AgentContext()
    asyncio.run(subject.run("delegate the fixture", environment, context))
    invocation = json.loads((environment.cwd / "invocation.json").read_text())
    for flag, value in (
        ("--delegation", "light"),
        ("--worker-model", "stress/worker-model"),
        ("--autonomy", "balanced"),
        ("--deadline", "600"),
    ):
        assert invocation[invocation.index(flag) + 1] == value
    assert invocation.index("--deadline") < invocation.index("--")

    subject.populate_context_post_run(context)
    root = Trajectory.model_validate_json(
        (subject.logs_dir / "trajectory.json").read_text()
    )
    child_path = subject.logs_dir / "trajectory-ses_child.json"
    child = Trajectory.model_validate_json(child_path.read_text())
    reference = root.steps[1].observation.results[0].subagent_trajectory_ref[0]
    assert reference.session_id == "ses_child"
    assert (subject.logs_dir / reference.trajectory_path) == child_path
    assert child.session_id == "ses_child"
    assert child.agent.model_name == "stress/worker-model"
    assert child.extra["binary"] == identity
    assert child.extra["parent_session_id"] == "ses_root"
    assert root.extra["child_sessions"] == ["ses_child"]
    assert root.extra["usage_complete"] is True
    assert root.extra["binary"]["delegation"] == "light"
    assert context.metadata["openscience"]["child_trajectories"] == {
        "ses_child": "trajectory-ses_child.json"
    }
    assert context.n_input_tokens == 633
    assert context.n_output_tokens == 72
    assert context.n_cache_tokens == 5
    assert context.cost_usd == pytest.approx(0.18)


def test_incomplete_delegated_run_still_counts_child_usage(tmp_path, monkeypatch):
    # The child's roll-up disagrees with its steps: totals are withheld, but
    # the leaderboard numbers still count root and child spend as a floor.
    stream = DELEGATION.read_text().replace(
        '"tokens":{"input":120,"output":22', '"tokens":{"input":121,"output":22'
    )
    subject, environment = local_agent(tmp_path, monkeypatch, events=stream)
    asyncio.run(subject.install(environment))
    context = AgentContext()
    asyncio.run(subject.run("delegate the fixture", environment, context))
    subject.populate_context_post_run(context)
    assert context.metadata["openscience"]["usage_complete"] is False
    assert context.metadata["openscience"]["child_metric_mismatches"] == {
        "ses_child": ["prompt_tokens"]
    }
    assert context.n_input_tokens == 634
    assert context.cost_usd == pytest.approx(0.18)
    assert (subject.logs_dir / "trajectory-ses_child.json").is_file()


def test_unsupported_workspace_fails_before_agent_execution(tmp_path, monkeypatch):
    subject, environment = local_agent(tmp_path, monkeypatch, supports_workspace=False)
    with pytest.raises(ValueError, match="lacks run --workspace project"):
        asyncio.run(subject.install(environment))
    assert not (environment.cwd / "invocation.json").exists()
    assert not (Path(subject.environment_logs_dir) / "openscience.txt").exists()


@pytest.mark.parametrize(
    "stream",
    [
        "",
        FIXTURE.read_text().rsplit("\n", 2)[0] + "\n",
        FIXTURE.read_text().replace(
            '"status":"completed","exitCode":0', '"status":"error","exitCode":1'
        ),
    ],
)
def test_remote_incomplete_or_failed_events_cannot_use_stale_success(
    tmp_path, monkeypatch, stream
):
    subject, environment = local_agent(tmp_path, monkeypatch, events=stream)
    asyncio.run(subject.install(environment))
    (subject.logs_dir / "openscience.txt").write_text(FIXTURE.read_text())
    with pytest.raises(NonZeroAgentExitCodeError):
        asyncio.run(subject.run("run fixture", environment, AgentContext()))
    assert (subject.logs_dir / "openscience.txt").read_text() == stream


def test_failed_trial_still_reports_spent_usage(tmp_path, monkeypatch):
    stream = FIXTURE.read_text().replace(
        '"status":"completed","exitCode":0', '"status":"error","exitCode":1'
    )
    subject, environment = local_agent(tmp_path, monkeypatch, events=stream)
    asyncio.run(subject.install(environment))
    with pytest.raises(NonZeroAgentExitCodeError):
        asyncio.run(subject.run("run fixture", environment, AgentContext()))
    context = AgentContext()
    subject.populate_context_post_run(context)
    assert context.n_input_tokens == 280
    assert context.n_output_tokens == 27
    assert context.cost_usd == 0
    assert context.metadata["openscience"]["usage_complete"] is False
    assert context.metadata["openscience"]["trace_complete"] is False


def test_process_failure_is_not_hidden_by_tee(tmp_path, monkeypatch):
    subject, environment = local_agent(tmp_path, monkeypatch, process_exit=17)
    asyncio.run(subject.install(environment))
    with pytest.raises(NonZeroAgentExitCodeError):
        asyncio.run(subject.run("run fixture", environment, AgentContext()))
    assert not environment.downloads  # Native Harbor collects logs after the exception.
    assert (Path(subject.environment_logs_dir) / "openscience.txt").is_file()


def test_reported_version_and_changed_local_binary_fail(tmp_path, monkeypatch):
    subject, environment = local_agent(tmp_path, monkeypatch, reported_version="2.0.71")
    with pytest.raises(ValueError, match="installed 2.0.71"):
        asyncio.run(subject.install(environment))
    Path(subject._binary).write_text("changed")
    with pytest.raises(ValueError, match="changed after"):
        asyncio.run(subject.install(environment))


def test_config_skills_and_explicit_cwd_execute(tmp_path, monkeypatch):
    custom = tmp_path / "custom-workdir"
    custom.mkdir()
    skills = tmp_path / "task-skills"
    skills.mkdir()
    (skills / ".skill-metadata").write_text("visible task skill")
    subject, environment = local_agent(
        tmp_path, monkeypatch, cwd=str(custom), skills_dir=str(skills)
    )
    asyncio.run(subject.install(environment))
    asyncio.run(subject.run("run fixture", environment, AgentContext()))
    config = json.loads((Path(subject._config_dir) / "openscience.json").read_text())
    assert config == subject.headless_config()
    assert (
        Path(subject._data_dir) / "user-skills" / ".skill-metadata"
    ).read_text() == "visible task skill"
    assert (custom / "invocation.json").is_file()


def test_native_resume_flag_is_scoped_to_resume_call(tmp_path, monkeypatch):
    subject, environment = local_agent(tmp_path, monkeypatch)
    asyncio.run(subject.install(environment))
    asyncio.run(subject.resume("resume fixture", environment, AgentContext()))
    assert "--continue" in json.loads((environment.cwd / "invocation.json").read_text())
    assert subject._resume is False
    asyncio.run(subject.run("new fixture", environment, AgentContext()))
    assert "--continue" not in json.loads(
        (environment.cwd / "invocation.json").read_text()
    )


def test_release_install_uses_tagged_script_and_forces_checksum(tmp_path):
    remote = tmp_path / "remote"
    remote.mkdir()
    environment = LocalEnvironment(tmp_path)
    helpers = tmp_path / "helpers"
    helpers.mkdir()
    executable = (
        '#!/bin/sh\nif [ "$2" = "--help" ]; then printf -- "--workspace project|isolated\\n"; '
        'else printf "2.0.70\\n"; fi\n'
    )
    installer = (
        "#!/bin/bash\nset -euo pipefail\n"
        'test "$OPENSCIENCE_SKIP_CHECKSUM" = 0\n'
        'test "$1" = --version && test "$2" = 2.0.70 && test "$3" = --no-modify-path\n'
        'mkdir -p "$HOME/.openscience/bin"\n'
        f"printf '%s' {shlex.quote(executable)} > \"$HOME/.openscience/bin/openscience\"\n"
        'chmod +x "$HOME/.openscience/bin/openscience"\n'
    )
    curl = helpers / "curl"
    curl.write_text(
        f"#!{sys.executable}\nimport pathlib, sys\n"
        f"pathlib.Path({str(tmp_path / 'installer-url')!r}).write_text(sys.argv[-1])\n"
        f"print({installer!r})\n"
    )
    curl.chmod(0o755)
    original = environment.exec

    async def with_helpers(**kwargs):
        kwargs["env"] = {
            **(kwargs.get("env") or {}),
            "PATH": str(helpers) + os.pathsep + os.environ["PATH"],
            "OPENSCIENCE_SKIP_CHECKSUM": "1",
        }
        return await original(**kwargs)

    environment.exec = with_helpers
    subject = agent(tmp_path, environment_logs_dir=PurePosixPath(remote))
    asyncio.run(subject.install(environment))
    assert (
        tmp_path / "installer-url"
    ).read_text() == module.INSTALL_ROOT + "/v2.0.70/install"
    assert subject._identity["source"] == "release"
    assert len(subject._identity["sha256"]) == 64
