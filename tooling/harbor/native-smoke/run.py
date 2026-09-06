"""One native Harbor trial against a candidate binary and a local fixture provider."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import tomllib
from harbor.agents.factory import AgentFactory
from harbor.models.job.config import JobConfig
from harbor.models.task.config import TaskConfig
from harbor.models.trajectories import Trajectory
from harbor.utils.trajectory_validator import TrajectoryValidator
from openscience_harbor.trajectory import completion_failure, parse

IMAGE = "docker.io/library/python@sha256:2fe5997d249a808b8eeea52c58a1dbffbba28754dc11699ef5c029f2d818ce79"
WORKSPACE = "/workspace/harbor-native-fixture"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--sha256", required=True, help="Expected candidate SHA-256")
    parser.add_argument(
        "--output", type=Path, required=True, help="New, nonexistent evidence directory"
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Build task image and run one Docker trial",
    )
    args = parser.parse_args()
    assert importlib.metadata.version("harbor") == "0.22.0", (
        "Use the pinned Harbor environment"
    )
    binary = args.binary.resolve(strict=True)
    with binary.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    assert digest == args.sha256.lower(), "Candidate SHA-256 mismatch"
    args.output.mkdir(parents=True, exist_ok=False)
    output = args.output.resolve()
    task = output / "task"
    shutil.copytree(Path(__file__).parent / "task", task)
    TaskConfig.model_validate_json(
        TaskConfig.model_validate(
            tomllib.loads((task / "task.toml").read_text())
        ).model_dump_json()
    )
    config = JobConfig.model_validate(
        {
            "job_name": "native-fixture",
            "jobs_dir": str(output / "jobs"),
            "n_attempts": 1,
            "n_concurrent_trials": 1,
            "retry": {"max_retries": 0},
            "environment": {"type": "docker", "delete": True},
            "agents": [
                {
                    "import_path": "openscience_harbor.agent:OpenScienceAgent",
                    "model_name": "stress/fixture-model",
                    "override_setup_timeout_sec": 120,
                    "env": {
                        "OPENSCIENCE_DISABLE_MODELS_FETCH": "true",
                        "OPENSCIENCE_DISABLE_DEFAULT_PLUGINS": "true",
                        "OPENSCIENCE_DISABLE_BUNDLED_SKILLS": "true",
                        "OPENSCIENCE_API_BASE": "http://127.0.0.1:9",
                    },
                    "kwargs": {
                        "binary": str(binary),
                        "binary_sha256": digest,
                        "effort": "normal",
                        "openscience_config": {
                            "model": "stress/fixture-model",
                            "small_model": "stress/fixture-model",
                            "enabled_providers": ["stress"],
                            "billing": {"llm": "byok"},
                            "provider": {
                                "stress": {
                                    "name": "Local deterministic conformance fixture",
                                    "npm": "@ai-sdk/openai-compatible",
                                    "env": [],
                                    "options": {
                                        "apiKey": "fixture-local-only",
                                        "baseURL": "http://127.0.0.1:8765/v1",
                                    },
                                    "models": {
                                        "fixture-model": {
                                            "name": "Fixture (no model inference)",
                                            "tool_call": True,
                                            "limit": {
                                                "context": 128000,
                                                "output": 4096,
                                            },
                                            "cost": {"input": 0, "output": 0},
                                        }
                                    },
                                }
                            },
                        },
                    },
                }
            ],
            "tasks": [{"path": str(task)}],
        }
    )
    path = output / "job.json"
    path.write_text(config.model_dump_json(indent=2))
    # Schema validation alone cannot detect a duplicated constructor kwarg.
    # Exercise Harbor's actual custom-agent factory before creating a trial.
    AgentFactory.create_agent_from_config(
        config.agents[0], logs_dir=output / "agent-preflight"
    )
    manifest = {
        "harbor": "0.22.0",
        "binary": str(binary),
        "sha256": digest,
        "base_image": IMAGE,
        "platform": "linux/amd64",
        "network": "Docker Compose network_mode:none; provider uses container loopback",
        "attempts": 1,
        "max_retries": 0,
        "model_calls": 0,
        "fixture_usage": "Synthetic protocol counters, not measured inference tokens",
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2))
    if not args.execute:
        print(json.dumps({"prepared": str(output), "executed": False}))
        return

    # Permit only local Docker. Keep model/provider credentials out of this child.
    endpoint = (
        os.environ.get("DOCKER_HOST")
        or subprocess.check_output(
            ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
            text=True,
        ).strip()
    )
    assert endpoint.startswith("unix://"), (
        "This fixture requires a local Unix Docker engine"
    )
    home = output / "home"
    home.mkdir()
    docker_config = home / ".docker"
    docker_config.mkdir()
    plugin_dir = (
        Path(os.environ.get("DOCKER_CONFIG", Path.home() / ".docker")) / "cli-plugins"
    )
    # Docker Desktop installs Compose here. Reuse executable discovery only,
    # without copying registry credentials or the user's Docker configuration.
    (docker_config / "config.json").write_text(
        json.dumps(
            {"cliPluginsExtraDirs": [str(plugin_dir)] if plugin_dir.is_dir() else []}
        )
    )
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(home),
        "DOCKER_HOST": endpoint,
        "DOCKER_DEFAULT_PLATFORM": "linux/amd64",
        "LITELLM_LOCAL_MODEL_COST_MAP": "True",
    }
    for key in ("TMPDIR",):
        if key in os.environ:
            env[key] = os.environ[key]
    harbor = Path(sys.executable).with_name("harbor")
    assert harbor.is_file(), "Run with the Python environment that contains Harbor"
    with (output / "harbor.log").open("w") as log:
        result = subprocess.run(
            [str(harbor), "run", "--config", str(path)],
            cwd=output,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
        )
    assert result.returncode == 0, (
        f"Harbor exited {result.returncode}; inspect {output / 'harbor.log'}"
    )
    trials = list((output / "jobs" / "native-fixture").glob("*/result.json"))
    assert len(trials) == 1, f"Expected exactly one native trial, got {len(trials)}"
    trial = trials[0].parent
    native = json.loads(trials[0].read_text())
    assert not native.get("exception_info"), native.get("exception_info")
    assert native["verifier_result"]["rewards"]["reward"] == 1
    identity = json.loads((trial / "agent" / "openscience-identity.json").read_text())
    assert identity["sha256"] == digest
    events = parse((trial / "agent" / "openscience.txt").read_text())
    assert completion_failure(events) is None
    trajectory = json.loads((trial / "agent" / "trajectory.json").read_text())
    Trajectory.model_validate(trajectory)
    validator = TrajectoryValidator()
    assert validator.validate(trajectory), validator.errors
    tools = [
        call for step in trajectory["steps"] for call in step.get("tool_calls", [])
    ]
    assert len(tools) == 1 and tools[0]["function_name"] == "bash", tools
    evidence = json.loads((trial / "verifier" / "evidence.json").read_text())
    assert evidence["passed"] and evidence["grader_cwd"] == WORKSPACE
    assert evidence["result"] == {"value": 42, "cwd": WORKSPACE}
    collected = trial / "artifacts" / WORKSPACE.lstrip("/") / "fixture-result.json"
    assert json.loads(collected.read_text()) == evidence["result"]
    requests = [
        json.loads(line)
        for line in (trial / "agent" / "fixture-provider.jsonl")
        .read_text()
        .splitlines()
    ]
    # This fixture needs a tool turn and a final answer; UI title generation
    # would introduce extra requests without contributing to its result.
    assert len(requests) == 2, requests
    assert sum(request["emitted_tool"] for request in requests) == 1
    assert any(request["has_tool_result"] for request in requests)
    environment = json.loads((trial / "agent" / "fixture-environment.json").read_text())
    assert environment["architecture"] == "x86_64", environment
    # Docker Desktop can expose inactive kernel tunnel interfaces. IFF_UP,
    # plus usable default routes, describes connectivity better than names.
    active = [
        name
        for name, details in environment["network_interfaces"].items()
        if details["flags"] & 1
    ]
    assert active == ["lo"], environment
    default4 = [
        row
        for line in environment["ipv4_routes"].splitlines()[1:]
        if (row := line.split())
        and row[1] == "00000000"
        and row[7] == "00000000"
        and int(row[3], 16) & 1
        and not int(row[3], 16) & 0x200
    ]
    default6 = [
        row
        for line in environment["ipv6_routes"].splitlines()
        if (row := line.split())
        and row[0] == "0" * 32
        and row[1] == "00"
        and int(row[-2], 16) & 1
        and not int(row[-2], 16) & 0x200
    ]
    assert not default4 and not default6, environment
    assert environment["cwd"] == WORKSPACE, environment
    report = {
        **manifest,
        "passed": True,
        "trial": str(trial),
        "identity": identity,
        "reward": 1,
        "atif_valid": True,
        "tool_calls": len(tools),
        "provider_requests": len(requests),
        "native_evidence": evidence,
        "container_environment": environment,
    }
    (output / "conformance.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
