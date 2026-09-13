#!/usr/bin/env python3
"""Run a native science benchmark against the OpenScience Harbor adapter.

Harbor, Inspect, and ResearchClawBench keep their own graders. This only
assembles the frozen identity and execs the matching runner.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from campaign import (
    HARBOR_BENCHES,
    SKILLS,
    harbor_argv,
    identity,
    load_datasets,
)

RESEARCHCLAW = ROOT / "adapters" / "researchclaw.py"
BIX = ROOT / "adapters" / "bixbench3.py"


def run(command: list[str], *, dry_run: bool) -> int:
    print(" ".join(command), file=sys.stderr)
    if dry_run:
        return 0
    return subprocess.call(command)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bench",
        required=True,
        choices=list(load_datasets()["benches"]),
    )
    parser.add_argument("--model", required=True)
    parser.add_argument("--binary")
    parser.add_argument("--version")
    parser.add_argument("--binary-sha256")
    parser.add_argument("--skills", choices=SKILLS, default="bundled")
    parser.add_argument("--effort", default="normal")
    parser.add_argument("--jobs-dir", default=str(ROOT / "jobs"))
    parser.add_argument("--n-concurrent", type=int, default=1)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--env", default="docker")
    parser.add_argument("--dataset-path")
    parser.add_argument("--workspace")
    parser.add_argument("--prompt-file")
    parser.add_argument("--instruction-file")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    record = identity(
        bench=args.bench,
        model=args.model,
        skills=args.skills,
        binary_sha256=args.binary_sha256,
        version=args.version,
    )
    jobs = Path(args.jobs_dir)
    jobs.mkdir(parents=True, exist_ok=True)
    (jobs / "identity.json").write_text(json.dumps(record, indent=2) + "\n")

    if args.bench in HARBOR_BENCHES:
        return run(
            harbor_argv(
                bench=args.bench,
                model=args.model,
                binary=args.binary,
                version=args.version,
                binary_sha256=args.binary_sha256,
                skills=args.skills,
                effort=args.effort,
                jobs_dir=str(jobs),
                n_concurrent=args.n_concurrent,
                limit=args.limit,
                env=args.env,
                dataset_path=args.dataset_path,
            ),
            dry_run=args.dry_run,
        )

    if args.bench == "researchclawbench":
        if not args.workspace or not args.prompt_file:
            raise SystemExit("researchclawbench needs --workspace and --prompt-file")
        command = [
            sys.executable,
            str(RESEARCHCLAW),
            "--model",
            args.model,
            "--prompt-file",
            args.prompt_file,
            "--workspace",
            args.workspace,
            "--skills",
            args.skills,
            "--effort",
            args.effort,
        ]
        if args.binary:
            command.extend(["--binary", args.binary])
        return run(command, dry_run=args.dry_run)

    if not args.instruction_file:
        raise SystemExit("bixbench3 needs --instruction-file (native task prompt)")
    command = [
        sys.executable,
        str(BIX),
        "command",
        "--model",
        args.model,
        "--instruction-file",
        args.instruction_file,
        "--skills",
        args.skills,
        "--effort",
        args.effort,
    ]
    if args.binary:
        command.extend(["--binary", args.binary])
    if args.workspace:
        command.extend(["--cwd", args.workspace])
    return run(command, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
