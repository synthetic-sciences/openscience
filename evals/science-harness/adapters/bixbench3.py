#!/usr/bin/env python3
"""Inspect solver that runs OpenScience inside a BixBench3 agent container.

BixBench3 keeps the GCP VM, mediated web proxy, 24h/5,000-message cap, and
host-side artifact grading. This replaces only the reference ReAct solver.
Install a Linux OpenScience binary on PATH in that container, then point the
Inspect task `solver=` at `openscience_bixbench3_agent`.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import sys
from pathlib import Path

SKILLS = ("bundled", "none")
WORK = "/workspace/work"


def command(
    *,
    model: str,
    instruction: str,
    binary: str = "openscience",
    skills: str = "bundled",
    effort: str = "normal",
    cwd: str = WORK,
) -> dict[str, object]:
    if skills not in SKILLS:
        raise ValueError("skills must be bundled or none")
    if "/" not in model:
        raise ValueError("model must be provider/model")
    env = {
        "OPENSCIENCE_DISABLE_AUTOUPDATE": "1",
        "OPENSCIENCE_DISABLE_LSP_DOWNLOAD": "1",
        "OPENSCIENCE_DISABLE_PROJECT_CONFIG": "1",
        "OPENSCIENCE_SKIP_ENVIRONMENT_BOOTSTRAP": "1",
    }
    if skills == "none":
        env["OPENSCIENCE_DISABLE_BUNDLED_SKILLS"] = "1"
    argv = [
        binary,
        "run",
        "--format",
        "json",
        "--auto-approve",
        "--workspace",
        "project",
        "--model",
        model,
        "--effort",
        effort,
        "--",
        instruction,
    ]
    return {"argv": argv, "cwd": cwd, "env": env}


def shell(spec: dict[str, object]) -> str:
    assigns = " ".join(f"{key}={shlex.quote(value)}" for key, value in spec["env"].items())
    quoted = " ".join(shlex.quote(part) for part in spec["argv"])
    return f"cd {shlex.quote(str(spec['cwd']))} && {assigns} {quoted}"


try:
    from inspect_ai.solver import Generate, Solver, TaskState, solver
    from inspect_ai.util import sandbox
except ImportError:
    solver = None
else:

    @solver
    def openscience_bixbench3_agent(
        model: str,
        binary: str = "openscience",
        skills: str = "bundled",
        effort: str = "normal",
    ) -> Solver:
        async def solve(state: TaskState, generate: Generate) -> TaskState:
            del generate
            instruction = state.input_text if hasattr(state, "input_text") else str(state.input)
            spec = command(
                model=model,
                instruction=instruction,
                binary=binary,
                skills=skills,
                effort=effort,
            )
            result = await sandbox().exec(
                ["sh", "-lc", shell(spec)],
                timeout=state.metadata.get("time_limit_seconds") if state.metadata else None,
            )
            if not result.success:
                raise RuntimeError(result.stderr or "OpenScience BixBench3 run failed")
            return state

        return solve


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["command"])
    parser.add_argument("--model", required=True)
    parser.add_argument("--instruction-file", type=Path, required=True)
    parser.add_argument("--binary", default="openscience")
    parser.add_argument("--skills", choices=SKILLS, default="bundled")
    parser.add_argument("--effort", default="normal")
    parser.add_argument("--cwd", default=WORK)
    args = parser.parse_args(argv)
    spec = command(
        model=args.model,
        instruction=args.instruction_file.read_text(encoding="utf-8"),
        binary=args.binary,
        skills=args.skills,
        effort=args.effort,
        cwd=args.cwd,
    )
    json.dump({"shell": shell(spec), **spec}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
