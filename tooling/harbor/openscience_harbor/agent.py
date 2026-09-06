"""OpenScience installed-agent adapter for the tested Harbor 0.22.0 contract."""

from __future__ import annotations

import copy
import hashlib
import json
import re
import shlex
from pathlib import Path, PurePosixPath
from typing import Any, ClassVar

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory
from harbor.utils.trajectory_utils import format_trajectory_json

from openscience_harbor import trajectory

INSTALL_ROOT = "https://raw.githubusercontent.com/synthetic-sciences/OpenScience"
BIN_DIR = "$HOME/.openscience/bin"
UPLOADED_BINARY = "/installed-agent/openscience"

# The headless environment contract documented in
# frontend/docs/src/content/openscience/sessions.mdx ("Headless and container
# runs"). Everything OpenScience writes lands under /logs/agent so Harbor
# collects it with the trial.
HEADLESS_ENV = {
    "OPENSCIENCE_DISABLE_AUTOUPDATE": "1",
    "OPENSCIENCE_DISABLE_LSP_DOWNLOAD": "1",
    "OPENSCIENCE_DISABLE_PROJECT_CONFIG": "1",
    "OPENSCIENCE_SKIP_ENVIRONMENT_BOOTSTRAP": "1",
}

# Full host access inside the task container (no bubblewrap there) and no
# tools that need a Synthetic Sciences account or paid remote compute.
DEFAULT_CONFIG: dict[str, Any] = {
    "sandbox": {"enabled": False},
    # Headless trials do not need model-generated UI labels. This existing
    # switch leaves research, compaction, and file-diff bookkeeping intact.
    "agent": {"title": {"disable": True}},
    "permission": {
        "*": "allow",
        "research_search": "deny",
        "atlas": "deny",
        "atlas_write": "deny",
        "remote_compute": "deny",
        "modal": "deny",
        "provider_compute": "deny",
        "compute_job": "deny",
    },
}


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    for key, value in override.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def _sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


class OpenScienceAgent(BaseInstalledAgent):
    """Run OpenScience headlessly inside a Harbor task container."""

    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True)
    _OUTPUT_FILENAME = "openscience.txt"

    SUPPORTS_ATIF = True
    SUPPORTS_RESUME = True
    CLI_FLAGS: ClassVar[list[CliFlag]] = [
        CliFlag(kwarg="variant", cli="--variant"),
        CliFlag(
            kwarg="effort", cli="--effort", type="enum", choices=["normal", "ultra"]
        ),
        CliFlag(kwarg="agent", cli="--agent"),
    ]

    def __init__(
        self,
        *args: Any,
        openscience_config: dict[str, Any] | None = None,
        binary: str | None = None,
        binary_sha256: str | None = None,
        cwd: str | None = None,
        **kwargs: Any,
    ):
        super().__init__(*args, **kwargs)
        if self._version:
            self._version = self._version.removeprefix("v")
            if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", self._version):
                raise ValueError("version must be an exact release such as 2.0.77")
        if not binary and not self._version:
            raise ValueError(
                "Pass an exact release with --ak version=<x.y.z> or --ak binary=<path>."
            )
        if cwd is not None and (not PurePosixPath(cwd).is_absolute() or "\x00" in cwd):
            raise ValueError("cwd must be an absolute path inside the task environment")
        if binary_sha256 is not None and (
            not isinstance(binary_sha256, str)
            or not re.fullmatch(r"[a-fA-F0-9]{64}", binary_sha256)
        ):
            raise ValueError(
                "binary_sha256 must be a 64-character hexadecimal SHA-256 digest"
            )
        if binary_sha256 is not None and not binary:
            raise ValueError("binary_sha256 requires binary")
        self._openscience_config: dict[str, Any] = openscience_config or {}
        json.dumps(self._openscience_config, allow_nan=False)
        self._binary = binary
        self._binary_digest = _sha256(Path(binary)) if binary else None
        if binary_sha256 and binary_sha256.lower() != self._binary_digest:
            raise ValueError("Local binary does not match binary_sha256")
        self._cwd = cwd
        self._instruction: str | None = None
        self._identity: dict[str, Any] = {}

    @staticmethod
    def name() -> str:
        return "openscience"

    def get_version_command(self) -> str | None:
        return f"{BIN_DIR}/openscience --version"

    # Paths inside the container, all collected by Harbor after the run.
    @property
    def _logs(self) -> str:
        return str(self.environment_logs_dir)

    @property
    def _data_dir(self) -> str:
        return f"{self._logs}/openscience/data"

    @property
    def _config_dir(self) -> str:
        return f"{self._logs}/openscience/config"

    async def install(self, environment: BaseEnvironment) -> None:
        # `coreutils` provides the `stdbuf` run() pipes through; `git` lets the
        # agent version-control the task directory when it chooses to.
        await self.ensure_system_dependencies(
            environment, ("curl", "bash", "coreutils", "git")
        )
        if self._binary:
            if _sha256(Path(self._binary)) != self._binary_digest:
                raise ValueError("Local binary changed after agent construction")
            await environment.upload_file(Path(self._binary), UPLOADED_BINARY)
            await self.exec_as_agent(
                environment,
                command=(
                    f"set -euo pipefail; mkdir -p {BIN_DIR} && "
                    f"install -m 755 {UPLOADED_BINARY} {BIN_DIR}/openscience"
                ),
            )
        else:
            # Pin the installer too; a mutable website script is not a release pin.
            url = f"{INSTALL_ROOT}/v{self._version}/install"
            await self.exec_as_agent(
                environment,
                command=(
                    f"set -euo pipefail; curl -fsSL {shlex.quote(url)} | "
                    f"OPENSCIENCE_SKIP_CHECKSUM=0 bash -s -- --version {shlex.quote(self._version)} --no-modify-path"
                ),
            )
        version = await self.exec_as_agent(
            environment, command=self.get_version_command()
        )
        installed_version = (version.stdout or "").strip().removeprefix("v")
        if not installed_version or "\n" in installed_version:
            raise ValueError("Installed OpenScience did not report a single version")
        if self._version and self._version != installed_version:
            raise ValueError(
                f"Requested OpenScience {self._version}, installed {installed_version}"
            )
        digest = await self.exec_as_agent(
            environment, command=f"sha256sum {BIN_DIR}/openscience"
        )
        sha256 = (digest.stdout or "").split(maxsplit=1)[0] if digest.stdout else ""
        if not re.fullmatch(r"[a-f0-9]{64}", sha256):
            raise ValueError("Installed OpenScience did not report a SHA-256 digest")
        if self._binary_digest and sha256 != self._binary_digest:
            raise ValueError("Uploaded OpenScience binary differs from the host binary")
        help_result = await self.exec_as_agent(
            environment, command=f"{BIN_DIR}/openscience run --help"
        )
        if not re.search(r"--workspace\b", help_result.stdout or ""):
            raise ValueError(
                "Installed OpenScience lacks run --workspace project. "
                "Use a candidate or pinned release that supports the native workspace contract."
            )
        self._identity = {
            "requested_version": self._version,
            "installed_version": installed_version,
            "sha256": sha256,
            "source": "local_binary" if self._binary else "release",
            "installer_url": None if self._binary else url,
        }
        self._version = installed_version
        await self.exec_as_agent(
            environment,
            command=(
                f"printf '%s\\n' {shlex.quote(json.dumps(self._identity))} > "
                f"{shlex.quote(self._logs + '/openscience-identity.json')}"
            ),
        )

    def headless_config(self) -> dict[str, Any]:
        config = copy.deepcopy(DEFAULT_CONFIG)
        if self.mcp_servers:
            mcp: dict[str, dict[str, Any]] = {}
            for server in self.mcp_servers:
                if server.transport == "stdio":
                    command = [server.command, *server.args] if server.command else []
                    mcp[server.name] = {"type": "local", "command": command}
                else:
                    mcp[server.name] = {
                        "type": "remote",
                        "url": server.url,
                        "oauth": False,
                    }
            config["mcp"] = mcp
        if self.model_name and "/" in self.model_name:
            provider, model_id = self.model_name.split("/", 1)
            entry: dict[str, Any] = {"models": {model_id: {}}}
            base_url = self.model_connection.configured_base_url
            if base_url:
                entry["options"] = {"baseURL": base_url}
            config["provider"] = {provider: entry}
        return _deep_merge(config, copy.deepcopy(self._openscience_config))

    def setup_command(self) -> str:
        parts = [
            f"mkdir -p {shlex.quote(self._config_dir)} {shlex.quote(self._data_dir)}",
            f"printf '%s\\n' {shlex.quote(json.dumps(self.headless_config(), indent=2))} > {shlex.quote(self._config_dir + '/openscience.json')}",
        ]
        if self.skills_dir:
            skills = shlex.quote(self._data_dir + "/user-skills")
            parts.append(
                f"mkdir -p {skills} && cp -R {shlex.quote(str(self.skills_dir) + '/.')} {skills}/"
            )
        return " && ".join(parts)

    def run_env(self) -> dict[str, str]:
        env = dict(self.model_connection.env)
        env.update(HEADLESS_ENV)
        env["OPENSCIENCE_DATA_DIR"] = self._data_dir
        env["OPENSCIENCE_CONFIG_DIR"] = self._config_dir
        return env

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        self._instruction = instruction
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model")

        env = self.run_env()
        await self.exec_as_agent(environment, command=self.setup_command(), env=env)

        flags = self.build_cli_flags()
        resume = "--continue " if self._resume else ""
        await self.exec_as_agent(
            environment,
            command=(
                f'export PATH="{BIN_DIR}:$PATH"; '
                f"openscience run --format json --auto-approve --workspace project --model {shlex.quote(self.model_name)} "
                f"{resume}{flags + ' ' if flags else ''}-- {shlex.quote(instruction)} "
                f"2>&1 </dev/null | stdbuf -oL tee {shlex.quote(self._logs + '/' + self._OUTPUT_FILENAME)}"
            ),
            env=env,
            cwd=self._cwd,
        )

        # Harbor downloads logs after run() returns. Remote environments do not
        # share logs_dir; checking it here would accept an empty or stale log.
        output = self.logs_dir / self._OUTPUT_FILENAME
        pending = self.logs_dir / ".openscience-current.txt"
        await environment.download_file(
            self._logs + "/" + self._OUTPUT_FILENAME, pending
        )
        pending.replace(output)
        events = self._events()
        detail = trajectory.completion_failure(events)
        if detail:
            raise NonZeroAgentExitCodeError(f"OpenScience run failed: {detail}")

    def _events(self) -> list[dict[str, Any]]:
        output = self.logs_dir / self._OUTPUT_FILENAME
        if not output.exists():
            return []
        return trajectory.parse(output.read_text(encoding="utf-8", errors="replace"))

    def populate_context_post_run(self, context: AgentContext) -> None:
        events = self._events()
        if not events:
            return
        data = trajectory.convert(
            events,
            agent_name=self.name(),
            agent_version=self.version() or "unknown",
            model_name=self.model_name,
            instruction=self._instruction,
        )
        if data and self._identity:
            data["extra"]["binary"] = self._identity
        result = Trajectory.model_validate(data) if data else None
        if result is None:
            return

        path = self.logs_dir / "trajectory.json"
        path.write_text(format_trajectory_json(result.to_json_dict()), encoding="utf-8")
        context.metadata = {"openscience": result.extra}

        metrics = result.final_metrics
        if metrics:
            context.cost_usd = metrics.total_cost_usd
            context.n_input_tokens = metrics.total_prompt_tokens
            context.n_output_tokens = metrics.total_completion_tokens
            context.n_cache_tokens = metrics.total_cached_tokens
