#!/usr/bin/env python3
"""Host-side OpenScience entry for ResearchClawBench.

Point evaluation/agents.json at this script. ResearchClawBench owns the
workspace, hidden paper, and rubric judge; this only runs the Research loop
in the supplied workspace.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

SKILLS = ("bundled", "none")


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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-p", "--prompt-file", required=True, type=Path)
    parser.add_argument("-w", "--workspace", required=True, type=Path)
    parser.add_argument("--model", default=os.environ.get("OPENSCIENCE_BENCH_MODEL"))
    parser.add_argument("--binary", default=os.environ.get("OPENSCIENCE_BINARY", "openscience"))
    parser.add_argument("--skills", choices=SKILLS, default="bundled")
    parser.add_argument("--effort", default="normal")
    args = parser.parse_args(argv)
    if not args.model:
        raise SystemExit("Pass --model or OPENSCIENCE_BENCH_MODEL as provider/model")
    prompt = args.prompt_file.read_text(encoding="utf-8")
    env = os.environ.copy()
    env["OPENSCIENCE_DISABLE_AUTOUPDATE"] = "1"
    env["OPENSCIENCE_DISABLE_LSP_DOWNLOAD"] = "1"
    env["OPENSCIENCE_DISABLE_PROJECT_CONFIG"] = "1"
    env["OPENSCIENCE_SKIP_ENVIRONMENT_BOOTSTRAP"] = "1"
    if args.skills == "none":
        env["OPENSCIENCE_DISABLE_BUNDLED_SKILLS"] = "1"
    return subprocess.call(
        command(
            model=args.model,
            prompt=prompt,
            workspace=args.workspace,
            binary=args.binary,
            skills=args.skills,
            effort=args.effort,
        ),
        cwd=args.workspace,
        env=env,
    )


if __name__ == "__main__":
    sys.exit(main())
