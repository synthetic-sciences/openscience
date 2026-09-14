#!/usr/bin/env python3
"""Stage local science-benchmark inputs and report what is still blocked.

Downloads Harbor datasets, freezes the TB4 science subset, clones native
runners, and writes a non-secret status file. It does not start a scored run.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from campaign import HARBOR_PROJECT, freeze_tb4, load_datasets, load_tb4_tasks

DATASETS = ROOT / "datasets"
STATUS = ROOT / "status.json"
LINUX_BINARY = ROOT / "binaries" / "linux-x64-baseline" / "openscience"
KEY_NAMES = (
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "HF_TOKEN",
    "HUGGING_FACE_HUB_TOKEN",
    "MODAL_TOKEN",
    "DAYTONA_API_KEY",
    "JUDGE_API_KEY",
)


def which(name: str) -> str | None:
    return shutil.which(name)


def run(command: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, text=True, capture_output=True)


def harbor(*args: str) -> subprocess.CompletedProcess[str]:
    return run(["uv", "run", "--project", str(HARBOR_PROJECT), "harbor", *args])


def present(command: str) -> bool:
    return which(command) is not None


def docker_ok() -> bool:
    if not present("docker"):
        return False
    return run(["docker", "info"]).returncode == 0


def docker_image_present(image: str) -> bool:
    if not docker_ok():
        return False
    return run(["docker", "image", "inspect", image]).returncode == 0


def harbor_hub_authenticated() -> bool:
    result = harbor("auth", "status")
    return result.returncode == 0 and "Not authenticated" not in (result.stdout + result.stderr)


def drugdiscovery_rubrics_populated(clone_dir: Path) -> dict[str, Any]:
    tasks = clone_dir / "benchmark" / "tasks"
    rubric_files = sorted(tasks.glob("*/tests/rubrics.json"))
    filled = 0
    for path in rubric_files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if data.get("ground_truth") or data.get("outcome_rubrics"):
            filled += 1
    return {"tasks": len(rubric_files), "rubrics_filled": filled, "tasks_dir": str(tasks)}


def sha256(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_harbor(dataset: str, dest: Path) -> dict[str, Any]:
    dest.mkdir(parents=True, exist_ok=True)
    if any(dest.rglob("task.toml")):
        return {"ok": True, "path": str(dest), "note": "already present"}
    result = harbor("datasets", "download", dataset, "--export", "-o", str(dest))
    record: dict[str, Any] = {
        "ok": result.returncode == 0,
        "path": str(dest),
        "stderr": (result.stderr or result.stdout).strip()[-2000:],
    }
    if result.returncode == 0:
        record["tasks"] = len(list(dest.rglob("task.toml")))
    return record


def clone(url: str, dest: Path) -> dict[str, Any]:
    if (dest / ".git").is_dir():
        return {"ok": True, "path": str(dest), "note": "already cloned"}
    dest.parent.mkdir(parents=True, exist_ok=True)
    result = run(["git", "clone", "--depth", "1", url, str(dest)])
    return {
        "ok": result.returncode == 0,
        "path": str(dest),
        "stderr": (result.stderr or result.stdout).strip()[-2000:],
    }


def hf_download(repo: str, revision: str, dest: Path) -> dict[str, Any]:
    dest.mkdir(parents=True, exist_ok=True)
    if any(dest.rglob("task.toml")):
        count = len(list(dest.rglob("task.toml")))
        if count >= 40:
            return {"ok": True, "path": str(dest), "note": "already present", "tasks": count}
    hf = which("hf") or which("huggingface-cli")
    if not hf:
        return {"ok": False, "path": str(dest), "stderr": "hf CLI is not installed"}
    args = [hf, "download", repo, "--repo-type", "dataset", "--revision", revision, "--local-dir", str(dest)]
    result = run(args)
    return {
        "ok": result.returncode == 0,
        "path": str(dest),
        "stderr": (result.stderr or result.stdout).strip()[-2000:],
    }


def write_researchclaw_agent(clone_dir: Path) -> dict[str, Any]:
    agents = clone_dir / "evaluation" / "agents.json"
    if not agents.is_file():
        return {"ok": False, "stderr": "evaluation/agents.json missing"}
    data = json.loads(agents.read_text(encoding="utf-8"))
    script = ROOT / "adapters" / "researchclaw.py"
    # Their leaderboard already lists an unrelated "Open Science"
    # (ai4s-research/open-science); the label must not collide with it.
    data["openscience"] = {
        "label": "OpenScience (Synthetic Sciences)",
        "icon": "S",
        "cmd": f"python3 {script} -p <PROMPT> -w <WORKSPACE>",
    }
    overlay = clone_dir / "evaluation" / "agents.openscience.json"
    overlay.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return {"ok": True, "path": str(overlay)}


def need_from_you(status: dict[str, Any]) -> list[str]:
    need: list[str] = []
    keys = status["keys"]
    if not status["host"]["docker"]:
        need.append("Start Docker Desktop (local Harbor) or give a Modal/Daytona token for cloud Harbor.")
    if not keys.get("ANTHROPIC_API_KEY") and not keys.get("OPENROUTER_API_KEY"):
        if keys.get("OPENAI_API_KEY"):
            need.append("Confirm the scored model. OPENAI_API_KEY is present; Anthropic/OpenRouter are not.")
        else:
            need.append("An agent provider key (Anthropic, OpenAI, or OpenRouter).")
    if not (keys.get("HF_TOKEN") or keys.get("HUGGING_FACE_HUB_TOKEN")):
        need.append(
            "Hugging Face token after accepting phylobio/BiomniBench-DA, EdisonScientific/BixBench3, "
            "and ScaleAI/DrugDiscoveryBench (gated rubrics)."
        )
    if not keys.get("GEMINI_API_KEY") and not keys.get("GOOGLE_API_KEY"):
        need.append("Gemini/Google key for the Biomni rubric judge (verifier only, kept off the agent env).")
    if not keys.get("JUDGE_API_KEY") and not keys.get("OPENAI_API_KEY"):
        need.append("Judge credentials for ResearchClawBench (JUDGE_*) and DrugDiscoveryBench (JUDGE_BASE_URL/JUDGE_API_KEY/JUDGE_MODEL).")
    if not status["binary"].get("linux"):
        need.append("A Linux x64 OpenScience binary for Harbor containers (host darwin binary cannot be uploaded).")
    if not status["datasets"].get("terminal-bench-4-science", {}).get("frozen"):
        need.append("TB4 science task freeze after a successful Harbor download.")
    if not status["datasets"].get("biomni-bench-50", {}).get("ok"):
        need.append("BiomniBench-DA download once the HF licence is accepted.")
    ddb = status["datasets"].get("drugdiscoverybench", {})
    if not ddb.get("ok"):
        need.append("DrugDiscoveryBench clone (scaleapi/DrugDiscoveryBench).")
    elif ddb.get("rubrics", {}).get("rubrics_filled", 0) < ddb.get("rubrics", {}).get("tasks", 1):
        need.append("DrugDiscoveryBench rubrics: accept the gated HF dataset, then run scripts/populate_rubrics.py in the clone.")
    if not ddb.get("image"):
        need.append("docker pull ghcr.io/scaleapi/drugdiscoverybench:1.0.0-lightweight (~6 GB pull, ~23 GB on disk).")
    if not status["host"].get("gcloud"):
        need.append("gcloud auth + billed GCP project, Cell Ranger tarballs, and a results bucket for BixBench3.")
    if not status["host"].get("harbor_hub_auth"):
        need.append("`harbor auth login` (GitHub OAuth) so `harbor hub job tasks` can pull other harnesses' per-task TB4 rewards for the science-subset delta.")
    need.append("Environment for the Terminal-Bench runs: Docker on this Mac emulates amd64; the leaderboards ran on Modal. Confirm Modal (or a Linux x86 host) for scored runs.")
    need.append("Concurrency, budget cap, and whether to run the skills=none ablation beside the product lane.")
    return need


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-download", action="store_true")
    args = parser.parse_args(argv)
    DATASETS.mkdir(parents=True, exist_ok=True)
    datasets_spec = load_datasets()

    host = {
        "docker": docker_ok(),
        "uv": present("uv"),
        "git": present("git"),
        "hf": present("hf") or present("huggingface-cli"),
        "gcloud": present("gcloud"),
        "harbor_hub_auth": harbor_hub_authenticated(),
        "openscience_host": None,
    }
    version = run(["openscience", "--version"]) if present("openscience") else None
    if version and version.returncode == 0:
        host["openscience_host"] = version.stdout.strip()

    keys = {name: bool(os.environ.get(name)) for name in KEY_NAMES}
    binary = {
        "linux": str(LINUX_BINARY) if LINUX_BINARY.is_file() else None,
        "linux_sha256": sha256(LINUX_BINARY),
    }

    dataset_status: dict[str, Any] = {}
    if not args.skip_download:
        tb_science = DATASETS / "terminal-bench-science"
        dataset_status["terminal-bench-science"] = download_harbor(
            datasets_spec["benches"]["terminal-bench-science"]["dataset"],
            tb_science,
        )
        tb4 = DATASETS / "terminal-bench-4"
        dataset_status["terminal-bench-4"] = download_harbor(
            datasets_spec["benches"]["terminal-bench-4-science"]["dataset"],
            tb4,
        )
        if dataset_status["terminal-bench-4"].get("ok"):
            try:
                names = freeze_tb4(tb4)
                dataset_status["terminal-bench-4-science"] = {
                    "ok": True,
                    "frozen": True,
                    "tasks": names,
                    "count": len(names),
                }
            except ValueError as error:
                dataset_status["terminal-bench-4-science"] = {"ok": False, "frozen": False, "stderr": str(error)}
        biomni = datasets_spec["benches"]["biomni-bench-50"]["huggingface"]
        dataset_status["biomni-bench-50"] = hf_download(
            biomni["dataset"],
            biomni["revision"],
            DATASETS / "biomni-bench-50",
        )
        dataset_status["researchclawbench"] = clone(
            "https://github.com/InternScience/ResearchClawBench.git",
            DATASETS / "researchclawbench",
        )
        if dataset_status["researchclawbench"].get("ok"):
            dataset_status["researchclawbench"]["agent"] = write_researchclaw_agent(
                DATASETS / "researchclawbench"
            )
        dataset_status["bixbench3"] = clone(
            "https://github.com/EdisonScientific/BixBench3.git",
            DATASETS / "bixbench3",
        )
        dataset_status["drugdiscoverybench"] = clone(
            "https://github.com/scaleapi/DrugDiscoveryBench.git",
            DATASETS / "drugdiscoverybench",
        )
    else:
        dataset_status["note"] = "downloads skipped"
        for name in ("researchclawbench", "bixbench3", "drugdiscoverybench"):
            if (DATASETS / name / ".git").is_dir():
                dataset_status[name] = {"ok": True, "path": str(DATASETS / name), "note": "already cloned"}

    ddb_dir = DATASETS / "drugdiscoverybench"
    if dataset_status.get("drugdiscoverybench", {}).get("ok"):
        ddb_spec = datasets_spec["benches"]["drugdiscoverybench"]
        dataset_status["drugdiscoverybench"]["rubrics"] = drugdiscovery_rubrics_populated(ddb_dir)
        dataset_status["drugdiscoverybench"]["image"] = docker_image_present(ddb_spec["image"])

    try:
        names = load_tb4_tasks()
        tb4_science = dataset_status.setdefault("terminal-bench-4-science", {})
        tb4_science["listed"] = names
        tb4_science["frozen"] = True
        tb4_science["count"] = len(names)
        tb4_science["ok"] = True
    except ValueError as error:
        dataset_status.setdefault("terminal-bench-4-science", {}).update(
            {"ok": False, "frozen": False, "stderr": str(error)}
        )

    status = {
        "checked_at": datetime.now(UTC).isoformat(),
        "host": host,
        "keys": keys,
        "binary": binary,
        "datasets": dataset_status,
        "skills_default": datasets_spec["skills_default"],
        "harbor": datasets_spec["harbor"],
    }
    status["need_from_you"] = need_from_you(status)
    STATUS.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(status, indent=2))
    return 0 if not status["need_from_you"] else 2


if __name__ == "__main__":
    sys.exit(main())
