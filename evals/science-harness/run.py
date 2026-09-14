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
from datetime import UTC, datetime
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
    redact,
)

RESEARCHCLAW = ROOT / "adapters" / "researchclaw.py"
BIX = ROOT / "adapters" / "bixbench3.py"


def run(command: list[str], *, dry_run: bool) -> int:
    print(" ".join(redact(command)), file=sys.stderr)
    if dry_run:
        return 0
    return subprocess.call(command)


def env_values(names: list[str], *, role: str) -> dict[str, str]:
    """Collect KEY=VALUE pairs from the host environment; missing keys are reported."""
    found = {name: os.environ[name] for name in names if os.environ.get(name)}
    missing = [name for name in names if name not in found]
    if missing:
        print(f"warning: {role} env not set: {', '.join(missing)}", file=sys.stderr)
    return found


def job_name(bench: str, model: str, skills: str) -> str:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return f"{bench}__{model.replace('/', '-')}__{skills}__{stamp}"


def main(argv: list[str] | None = None) -> int:
    datasets = load_datasets()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bench", required=True, choices=list(datasets["benches"]))
    parser.add_argument("--model", required=True)
    parser.add_argument("--binary")
    parser.add_argument("--version")
    parser.add_argument("--binary-sha256")
    parser.add_argument("--skills", choices=SKILLS, default="bundled")
    parser.add_argument("--effort", default="normal")
    parser.add_argument("--variant", help="Model reasoning variant forwarded as --variant")
    parser.add_argument(
        "--attempts",
        type=int,
        default=datasets.get("attempts_default", 1),
        help="Trials per task (leaderboards report 3)",
    )
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

    spec = datasets["benches"][args.bench]
    record = identity(
        bench=args.bench,
        model=args.model,
        skills=args.skills,
        binary_sha256=args.binary_sha256,
        version=args.version,
        effort=args.effort,
        variant=args.variant,
        attempts=args.attempts,
        env=args.env if args.bench in HARBOR_BENCHES else None,
    )
    jobs = Path(args.jobs_dir)
    jobs.mkdir(parents=True, exist_ok=True)
    name = job_name(args.bench, args.model, args.skills)
    record["job_name"] = name
    # Sibling file: Harbor owns jobs/<name>/ and must find it absent on start.
    (jobs / f"{name}.identity.json").write_text(json.dumps(record, indent=2) + "\n")

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
                variant=args.variant,
                attempts=args.attempts,
                jobs_dir=str(jobs),
                job_name=name,
                n_concurrent=args.n_concurrent,
                limit=args.limit,
                env=args.env,
                dataset_path=args.dataset_path,
                verifier_env=env_values(spec.get("judge_env", []), role="judge"),
                agent_env=env_values(spec.get("agent_env", []), role="agent"),
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
