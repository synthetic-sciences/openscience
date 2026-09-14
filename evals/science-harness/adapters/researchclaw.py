#!/usr/bin/env python3
"""Host-side OpenScience entry for ResearchClawBench.

Point evaluation/agents.json at this script. ResearchClawBench owns the
workspace, hidden paper, and rubric judge; this only runs the Research loop
in the supplied workspace.

Their runner (evaluation/run_task.py) rewrites ``<PROMPT>`` to the prompt
*text* via ``"$(cat INSTRUCTIONS.md)"`` and ``<WORKSPACE>`` to an absolute
path, then runs the command with ``shell=True`` and cwd=workspace. It also
scans the first 50 stdout lines for a JSON object with a top-level ``model``
key, so the first line printed here identifies the scored model.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

SKILLS = ("bundled", "none")
HEADLESS_ENV = {
    "OPENSCIENCE_DISABLE_AUTOUPDATE": "1",
    "OPENSCIENCE_DISABLE_LSP_DOWNLOAD": "1",
    "OPENSCIENCE_DISABLE_PROJECT_CONFIG": "1",
    "OPENSCIENCE_SKIP_ENVIRONMENT_BOOTSTRAP": "1",
}


def command(
    *,
    model: str,
    prompt: str,
    workspace: Path,
    binary: str = "openscience",
    skills: str = "bundled",
    effort: str = "normal",
) -> list[str]:
    if skills not in SKILLS:
        raise ValueError("skills must be bundled or none")
    if "/" not in model:
        raise ValueError("model must be provider/model")
    if not prompt.strip():
        raise ValueError("prompt is empty")
    return [
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
        prompt,
    ]


def environment(skills: str) -> dict[str, str]:
    env = os.environ.copy()
    env.update(HEADLESS_ENV)
    if skills == "none":
        env["OPENSCIENCE_DISABLE_BUNDLED_SKILLS"] = "1"
    return env


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("-p", "--prompt", help="Prompt text (what ResearchClawBench passes)")
    source.add_argument("--prompt-file", type=Path, help="Read the prompt from a file instead")
    parser.add_argument("-w", "--workspace", required=True, type=Path)
    parser.add_argument("--model", default=os.environ.get("OPENSCIENCE_BENCH_MODEL"))
    parser.add_argument("--binary", default=os.environ.get("OPENSCIENCE_BINARY", "openscience"))
    parser.add_argument("--skills", choices=SKILLS, default=os.environ.get("OPENSCIENCE_BENCH_SKILLS", "bundled"))
    parser.add_argument("--effort", default=os.environ.get("OPENSCIENCE_BENCH_EFFORT", "normal"))
    args = parser.parse_args(argv)
    if not args.model:
        raise SystemExit("Pass --model or OPENSCIENCE_BENCH_MODEL as provider/model")
    prompt = args.prompt if args.prompt is not None else args.prompt_file.read_text(encoding="utf-8")
    workspace = args.workspace.resolve()
    if not workspace.is_dir():
        raise SystemExit(f"workspace {workspace} is not a directory")
    print(
        json.dumps(
            {
                "model": args.model,
                "agent": "openscience",
                "skills": args.skills,
                "effort": args.effort,
                "workspace": str(workspace),
            }
        ),
        flush=True,
    )
    return subprocess.call(
        command(
            model=args.model,
            prompt=prompt,
            workspace=workspace,
            binary=args.binary,
            skills=args.skills,
            effort=args.effort,
        ),
        cwd=workspace,
        env=environment(args.skills),
    )


if __name__ == "__main__":
    sys.exit(main())
