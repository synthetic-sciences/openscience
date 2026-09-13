#!/usr/bin/env python3
"""Frozen identity and argv for native science-benchmark campaigns.

This does not run Harbor, Inspect, or a model. It only records which runner
owns each bench and how to invoke the existing OpenScience installed-agent
adapter. Bundled skills stay on unless the caller asks for the none ablation.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
DATASETS = ROOT / "datasets.json"
TB4_TASKS = ROOT / "tb4-science-tasks.json"
HARBOR_PROJECT = Path(__file__).resolve().parents[2] / "tooling" / "harbor"
AGENT = "openscience_harbor.agent:OpenScienceAgent"
SKILLS = ("bundled", "none")
HARBOR_BENCHES = (
    "terminal-bench-science",
    "terminal-bench-4-science",
    "biomni-bench-50",
)

DOMAIN_RE = re.compile(
    r'(?im)^(?:domain|category)\s*=\s*["\']science["\']'
    r'|(?im)^\s*["\']science["\']\s*,?\s*$'
)


def load_datasets() -> dict[str, Any]:
    return json.loads(DATASETS.read_text(encoding="utf-8"))


def load_tb4_tasks() -> list[str]:
    payload = json.loads(TB4_TASKS.read_text(encoding="utf-8"))
    tasks = payload.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise ValueError(
            "tb4-science-tasks.json has no frozen task IDs. "
            "Download terminal-bench/terminal-bench@4.0.0 and run freeze-tb4."
        )
    names = [str(name) for name in tasks]
    if names != sorted(set(names)):
        raise ValueError("TB4 science task IDs must be unique and sorted")
    return names


def science_task_names(dataset_dir: Path) -> list[str]:
    names: list[str] = []
    for task_toml in sorted(dataset_dir.rglob("task.toml")):
        text = task_toml.read_text(encoding="utf-8")
        if DOMAIN_RE.search(text):
            names.append(task_toml.parent.name)
    return sorted(set(names))


def freeze_tb4(dataset_dir: Path, output: Path = TB4_TASKS) -> list[str]:
    names = science_task_names(dataset_dir)
    if not names:
        raise ValueError(f"No science-domain tasks under {dataset_dir}")
    output.write_text(
        json.dumps(
            {
                "dataset": "terminal-bench/terminal-bench@4.0.0",
                "filter": "domain:science",
                "tasks": names,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return names


def harbor_argv(
    *,
    bench: str,
    model: str,
    binary: str | None = None,
    version: str | None = None,
    binary_sha256: str | None = None,
    skills: str = "bundled",
    effort: str = "normal",
    jobs_dir: str | None = None,
    n_concurrent: int = 1,
    limit: int | None = None,
    env: str = "docker",
    dataset_path: str | None = None,
) -> list[str]:
    if skills not in SKILLS:
        raise ValueError("skills must be bundled or none")
    if "/" not in model:
        raise ValueError("model must be provider/model")
    if not binary and not version:
        raise ValueError("Pass --binary or --version")
    if bench not in HARBOR_BENCHES:
        raise ValueError(f"{bench} is not a Harbor campaign")

    datasets = load_datasets()
    spec = datasets["benches"][bench]
    argv = [
        "uv",
        "run",
        "--project",
        str(HARBOR_PROJECT),
        "harbor",
        "run",
        "-a",
        AGENT,
        "-m",
        model,
        "--ak",
        f"skills={skills}",
        "--ak",
        f"effort={effort}",
        "--n-concurrent",
        str(n_concurrent),
        "--env",
        env,
    ]
    if binary:
        argv.extend(["--ak", f"binary={binary}"])
    if binary_sha256:
        argv.extend(["--ak", f"binary_sha256={binary_sha256}"])
    if version:
        argv.extend(["--ak", f"version={version}"])
    if jobs_dir:
        argv.extend(["--jobs-dir", jobs_dir])
    if limit is not None:
        argv.extend(["-k", str(limit)])

    if bench == "biomni-bench-50":
        if not dataset_path:
            raise ValueError("biomni-bench-50 needs the downloaded Hugging Face path")
        argv.extend(["--path", dataset_path])
    else:
        argv.extend(["-d", spec["dataset"]])

    if bench == "terminal-bench-4-science":
        for name in load_tb4_tasks():
            argv.extend(["--task-name", name])
    return argv


def identity(
    *,
    bench: str,
    model: str,
    skills: str,
    binary_sha256: str | None = None,
    version: str | None = None,
) -> dict[str, Any]:
    datasets = load_datasets()
    spec = datasets["benches"][bench]
    record: dict[str, Any] = {
        "bench": bench,
        "runner": spec["runner"],
        "metric": spec["metric"],
        "agent": AGENT,
        "harbor": datasets["harbor"],
        "model": model,
        "skills": skills,
        "binary_sha256": binary_sha256,
        "version": version,
    }
    if bench == "terminal-bench-4-science":
        record["tasks"] = load_tb4_tasks()
    return record


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    freeze = sub.add_parser("freeze-tb4", help="Write science task IDs from a TB4 checkout")
    freeze.add_argument("--dataset-dir", type=Path, required=True)

    show = sub.add_parser("argv", help="Print the Harbor invocation without running it")
    show.add_argument("--bench", required=True, choices=HARBOR_BENCHES)
    show.add_argument("--model", required=True)
    show.add_argument("--binary")
    show.add_argument("--version")
    show.add_argument("--binary-sha256")
    show.add_argument("--skills", choices=SKILLS, default="bundled")
    show.add_argument("--effort", default="normal")
    show.add_argument("--jobs-dir")
    show.add_argument("--n-concurrent", type=int, default=1)
    show.add_argument("--limit", type=int)
    show.add_argument("--env", default="docker")
    show.add_argument("--dataset-path")

    ident = sub.add_parser("identity", help="Print the frozen campaign identity")
    ident.add_argument("--bench", required=True, choices=list(load_datasets()["benches"]))
    ident.add_argument("--model", required=True)
    ident.add_argument("--skills", choices=SKILLS, default="bundled")
    ident.add_argument("--binary-sha256")
    ident.add_argument("--version")

    args = parser.parse_args(argv)
    if args.command == "freeze-tb4":
        names = freeze_tb4(args.dataset_dir)
        print("\n".join(names))
        return 0
    if args.command == "argv":
        print(
            json.dumps(
                harbor_argv(
                    bench=args.bench,
                    model=args.model,
                    binary=args.binary,
                    version=args.version,
                    binary_sha256=args.binary_sha256,
                    skills=args.skills,
                    effort=args.effort,
                    jobs_dir=args.jobs_dir,
                    n_concurrent=args.n_concurrent,
                    limit=args.limit,
                    env=args.env,
                    dataset_path=args.dataset_path,
                )
            )
        )
        return 0
    print(
        json.dumps(
            identity(
                bench=args.bench,
                model=args.model,
                skills=args.skills,
                binary_sha256=args.binary_sha256,
                version=args.version,
            ),
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
