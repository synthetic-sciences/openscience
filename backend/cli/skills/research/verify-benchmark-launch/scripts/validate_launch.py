#!/usr/bin/env python3
"""Validate an official benchmark launch without exposing hidden benchmark content."""

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path


CHECKS = (
    "clean_checkout",
    "locked_environment",
    "task_manifest_load",
    "evaluator_load",
    "hidden_boundary",
    "deterministic_replay",
    "artifact_roundtrip",
    "baseline_replay",
)
HEX = set("0123456789abcdef")
VERSION = "1"


def fail(message: str) -> None:
    raise ValueError(message)


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def file_hash(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def script_hash() -> str:
    return file_hash(Path(__file__).resolve())


def valid_hash(value: object, size: int = 64) -> bool:
    return isinstance(value, str) and len(value) == size and set(value) <= HEX


def mapping(value: object, name: str) -> dict:
    if not isinstance(value, dict):
        fail(f"{name} must be an object")
    return value


def text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value:
        fail(f"{name} must be a non-empty string")
    return value


def expected_hash(value: object, name: str) -> str:
    if not valid_hash(value):
        fail(f"{name} must be a lowercase SHA-256")
    return str(value)


def root(base: Path, value: object, name: str) -> Path:
    source = Path(text(value, name)).expanduser()
    target = source if source.is_absolute() else base / source
    return target.resolve()


def inside(parent: Path, value: object, name: str) -> Path:
    source = Path(text(value, name))
    if source.is_absolute():
        fail(f"{name} must be relative")
    target = (parent / source).resolve()
    try:
        target.relative_to(parent)
    except ValueError:
        fail(f"{name} escapes its declared root")
    return target


def regular(path: Path, name: str) -> Path:
    if not path.is_file():
        fail(f"{name} is not a readable regular file")
    return path


def write(path: Path, value: object, force: bool) -> None:
    if path.exists() and not force:
        fail(f"output already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def git(workspace: Path, *args: str) -> tuple[int, str]:
    result = subprocess.run(
        ["git", "-C", str(workspace), *args],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    return result.returncode, result.stdout.strip()


def repository(value: str) -> str:
    normalized = value.strip().rstrip("/")
    return normalized[:-4] if normalized.endswith(".git") else normalized


def score(value: object, key: str) -> float:
    current = value
    for part in key.split("."):
        if not isinstance(current, dict) or part not in current:
            fail(f"baseline score key does not exist: {key}")
        current = current[part]
    if isinstance(current, bool) or not isinstance(current, (int, float)) or not math.isfinite(current):
        fail(f"baseline score key is not a finite number: {key}")
    return float(current)


def check(identifier: str, passed: bool, evidence: list[str], failures: list[str], reason: str) -> dict:
    if not passed:
        failures.append(f"{identifier}:{reason}")
    return {"id": identifier, "status": "passed" if passed else "failed", "evidence": sorted(set(evidence))}


def probe(args: argparse.Namespace) -> int:
    agent = Path(args.agent_root).expanduser().resolve()
    if not agent.is_dir():
        fail("agent root must be an existing directory")
    if len(args.hidden_path) < 1:
        fail("at least one hidden canary path is required")
    rows = []
    for value in args.hidden_path:
        target = Path(value).expanduser().resolve(strict=False)
        accessible = False
        reason = "blocked"
        descriptor = None
        try:
            descriptor = os.open(target, os.O_RDONLY)
            os.read(descriptor, 1)
            accessible = True
            reason = "readable"
        except FileNotFoundError:
            reason = "not-mounted"
        except PermissionError:
            reason = "permission-denied"
        except OSError as error:
            reason = error.__class__.__name__
        finally:
            if descriptor is not None:
                os.close(descriptor)
        rows.append(
            {
                "commitment": hashlib.sha256(str(target).encode("utf-8")).hexdigest(),
                "accessible": accessible,
                "reason": reason,
            }
        )
    checks = sorted(rows, key=lambda item: item["commitment"])
    receipt = {
        "schemaVersion": 1,
        "validator": {"name": "verify-benchmark-launch", "version": VERSION, "scriptSHA256": script_hash()},
        "agentRoot": str(agent),
        "checks": checks,
        "passed": not any(item["accessible"] for item in checks),
    }
    write(Path(args.output).expanduser().resolve(), receipt, args.force)
    print(json.dumps({"passed": receipt["passed"], "checks": len(checks)}))
    return 0 if receipt["passed"] else 1


def validate(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest).expanduser().resolve()
    manifest = mapping(json.loads(regular(manifest_path, "launch manifest").read_text(encoding="utf-8")), "manifest")
    if manifest.get("schemaVersion") != 1:
        fail("manifest schemaVersion must be 1")
    base = manifest_path.parent
    workspace = root(base, manifest.get("workspace"), "workspace")
    results = root(base, manifest.get("resultsRoot"), "resultsRoot")
    if not workspace.is_dir() or not results.is_dir():
        fail("workspace and resultsRoot must be existing directories")

    runner = mapping(manifest.get("runner"), "runner")
    repo = text(runner.get("repository"), "runner.repository")
    revision = text(runner.get("revision"), "runner.revision")
    if len(revision) not in (40, 64) or set(revision) > HEX:
        fail("runner.revision must be a 40- or 64-character lowercase hexadecimal revision")
    entrypoint = inside(workspace, runner.get("entrypoint"), "runner.entrypoint")
    command = runner.get("command")
    if not isinstance(command, list) or not command or any(not isinstance(item, str) or not item for item in command):
        fail("runner.command must be a non-empty string array")
    command_hash = expected_hash(runner.get("commandSHA256"), "runner.commandSHA256")
    native = runner.get("recipe")
    recipe_hash = None
    driver_hash = None
    native_ok = True
    native_evidence = []
    if native is not None:
        native = mapping(native, "runner.recipe")
        native_artifact = regular(root(base, native.get("artifact"), "runner.recipe.artifact"), "recipe artifact")
        native_artifact_hash = expected_hash(native.get("artifactSHA256"), "runner.recipe.artifactSHA256")
        recipe_hash = expected_hash(native.get("recipeSHA256"), "runner.recipe.recipeSHA256")
        driver_hash = expected_hash(native.get("driverSHA256"), "runner.recipe.driverSHA256")
        native_data = mapping(json.loads(native_artifact.read_text(encoding="utf-8")), "recipe artifact")
        stages = native_data.get("stages")
        launch_stage = native_data.get("launchStage")
        launch_driver = None
        if isinstance(stages, list):
            for stage in stages:
                if isinstance(stage, dict) and stage.get("id") == launch_stage:
                    launch_driver = stage.get("driver")
                    break
        actual_native_artifact_hash = file_hash(native_artifact)
        actual_driver_hash = digest(launch_driver) if isinstance(launch_driver, dict) else ""
        native_ok = (
            actual_native_artifact_hash == native_artifact_hash
            and native_data.get("schemaVersion") == 1
            and native_data.get("recipeSHA256") == recipe_hash
            and native_data.get("driverSHA256") == driver_hash
            and native_data.get("entrypoint") == runner.get("entrypoint")
            and actual_driver_hash == driver_hash
        )
        native_evidence = [
            f"recipe-artifact-sha256:{actual_native_artifact_hash}",
            f"recipe-sha256:{recipe_hash}",
            f"driver-sha256:{actual_driver_hash}",
        ]
    environment = mapping(runner.get("environment"), "runner.environment")
    files = environment.get("files")
    if not isinstance(files, list) or not files or any(not isinstance(item, str) or not item for item in files):
        fail("runner.environment.files must be a non-empty string array")
    if len(set(files)) != len(files):
        fail("runner.environment.files must be unique")
    environment_hash = expected_hash(environment.get("sha256"), "runner.environment.sha256")

    dataset = mapping(manifest.get("dataset"), "dataset")
    dataset_root = root(base, dataset.get("root"), "dataset.root")
    if not dataset_root.is_dir():
        fail("dataset.root must be an existing directory")
    dataset_name = text(dataset.get("name"), "dataset.name")
    dataset_source = text(dataset.get("source"), "dataset.source")
    dataset_revision = text(dataset.get("revision"), "dataset.revision")
    revision_file = regular(inside(dataset_root, dataset.get("revisionFile"), "dataset.revisionFile"), "revision file")
    dataset_manifest = regular(inside(dataset_root, dataset.get("manifest"), "dataset.manifest"), "dataset manifest")
    dataset_hash = expected_hash(dataset.get("manifestSHA256"), "dataset.manifestSHA256")

    task = mapping(manifest.get("task"), "task")
    task_manifest = regular(inside(workspace, task.get("manifest"), "task.manifest"), "task manifest")
    task_hash = expected_hash(task.get("sha256"), "task.sha256")
    evaluator = mapping(manifest.get("evaluator"), "evaluator")
    evaluator_artifact = regular(
        inside(workspace, evaluator.get("artifact"), "evaluator.artifact"), "evaluator artifact"
    )
    evaluator_hash = expected_hash(evaluator.get("sha256"), "evaluator.sha256")

    boundary = mapping(manifest.get("boundary"), "boundary")
    boundary_receipt = regular(root(base, boundary.get("receipt"), "boundary.receipt"), "boundary receipt")
    boundary_hash = expected_hash(boundary.get("receiptSHA256"), "boundary.receiptSHA256")
    agent_root = str(root(base, boundary.get("agentRoot"), "boundary.agentRoot"))
    commitments = boundary.get("hiddenCommitments")
    if not isinstance(commitments, list) or not commitments or any(not valid_hash(item) for item in commitments):
        fail("boundary.hiddenCommitments must contain lowercase SHA-256 values")
    if len(set(commitments)) != len(commitments):
        fail("boundary.hiddenCommitments must be unique")

    replay = mapping(manifest.get("replay"), "replay")
    replay_first = regular(inside(results, replay.get("first"), "replay.first"), "first replay")
    replay_second = regular(inside(results, replay.get("second"), "replay.second"), "second replay")
    roundtrip = mapping(manifest.get("roundtrip"), "roundtrip")
    exported = regular(inside(results, roundtrip.get("exported"), "roundtrip.exported"), "exported artifact")
    imported = regular(inside(results, roundtrip.get("imported"), "roundtrip.imported"), "imported artifact")

    baseline = mapping(manifest.get("baseline"), "baseline")
    baseline_name = text(baseline.get("name"), "baseline.name")
    baseline_artifact = regular(inside(results, baseline.get("artifact"), "baseline.artifact"), "baseline artifact")
    baseline_hash = expected_hash(baseline.get("artifactSHA256"), "baseline.artifactSHA256")
    score_file = regular(inside(results, baseline.get("scoreFile"), "baseline.scoreFile"), "baseline score file")
    score_key = text(baseline.get("scoreKey"), "baseline.scoreKey")
    expected = baseline.get("expectedScore")
    tolerance = baseline.get("tolerance")
    if isinstance(expected, bool) or not isinstance(expected, (int, float)) or not math.isfinite(expected):
        fail("baseline.expectedScore must be finite")
    if isinstance(tolerance, bool) or not isinstance(tolerance, (int, float)) or not math.isfinite(tolerance) or tolerance < 0:
        fail("baseline.tolerance must be finite and nonnegative")

    failures = []
    head_code, head = git(workspace, "rev-parse", "HEAD")
    origin_code, origin = git(workspace, "remote", "get-url", "origin")
    status_code, status = git(workspace, "status", "--porcelain", "--untracked-files=all")
    clean = (
        head_code == 0
        and origin_code == 0
        and status_code == 0
        and head == revision
        and repository(origin) == repository(repo)
        and not status
        and entrypoint.is_file()
    )

    actual_command_hash = digest(command)
    locks = sorted(
        ({"path": value, "sha256": file_hash(regular(inside(workspace, value, f"environment file {value}"), value))}
         for value in files),
        key=lambda item: item["path"],
    )
    actual_environment_hash = digest(locks)
    actual_dataset_hash = file_hash(dataset_manifest)
    actual_task_hash = file_hash(task_manifest)
    actual_evaluator_hash = file_hash(evaluator_artifact)
    boundary_bytes_hash = file_hash(boundary_receipt)
    boundary_data = mapping(json.loads(boundary_receipt.read_text(encoding="utf-8")), "boundary receipt")
    boundary_validator = mapping(boundary_data.get("validator"), "boundary receipt validator")
    boundary_checks = boundary_data.get("checks")
    boundary_ok = (
        boundary_bytes_hash == boundary_hash
        and boundary_data.get("schemaVersion") == 1
        and boundary_data.get("passed") is True
        and boundary_data.get("agentRoot") == agent_root
        and boundary_validator.get("name") == "verify-benchmark-launch"
        and boundary_validator.get("version") == VERSION
        and boundary_validator.get("scriptSHA256") == script_hash()
        and isinstance(boundary_checks, list)
        and sorted(item.get("commitment") for item in boundary_checks if isinstance(item, dict)) == sorted(commitments)
        and all(isinstance(item, dict) and item.get("accessible") is False for item in boundary_checks)
    )
    replay_first_hash = file_hash(replay_first)
    replay_second_hash = file_hash(replay_second)
    exported_hash = file_hash(exported)
    imported_hash = file_hash(imported)
    actual_baseline_hash = file_hash(baseline_artifact)
    observed = score(json.loads(score_file.read_text(encoding="utf-8")), score_key)

    checks = [
        check("clean_checkout", clean, [f"git:{head}", f"origin:{repository(origin)}"], failures, "git-state-mismatch"),
        check(
            "locked_environment",
            actual_command_hash == command_hash and actual_environment_hash == environment_hash and native_ok,
            [f"command-sha256:{actual_command_hash}", f"environment-sha256:{actual_environment_hash}", *native_evidence],
            failures,
            "command-environment-or-recipe-mismatch",
        ),
        check(
            "task_manifest_load",
            revision_file.read_text(encoding="utf-8").strip() == dataset_revision
            and actual_dataset_hash == dataset_hash
            and actual_task_hash == task_hash
            and task_manifest.stat().st_size > 0,
            [f"dataset-sha256:{actual_dataset_hash}", f"task-sha256:{actual_task_hash}"],
            failures,
            "dataset-or-task-mismatch",
        ),
        check(
            "evaluator_load",
            actual_evaluator_hash == evaluator_hash and evaluator_artifact.stat().st_size > 0,
            [f"evaluator-sha256:{actual_evaluator_hash}"],
            failures,
            "evaluator-mismatch",
        ),
        check(
            "hidden_boundary",
            boundary_ok,
            [f"boundary-sha256:{boundary_bytes_hash}"],
            failures,
            "boundary-probe-failed",
        ),
        check(
            "deterministic_replay",
            replay_first_hash == replay_second_hash,
            [f"first-sha256:{replay_first_hash}", f"second-sha256:{replay_second_hash}"],
            failures,
            "replay-mismatch",
        ),
        check(
            "artifact_roundtrip",
            exported_hash == imported_hash,
            [f"export-sha256:{exported_hash}", f"import-sha256:{imported_hash}"],
            failures,
            "roundtrip-mismatch",
        ),
        check(
            "baseline_replay",
            actual_baseline_hash == baseline_hash and abs(observed - float(expected)) <= float(tolerance),
            [f"artifact-sha256:{actual_baseline_hash}", f"score-file-sha256:{file_hash(score_file)}"],
            failures,
            "baseline-mismatch",
        ),
    ]
    if [item["id"] for item in checks] != list(CHECKS):
        fail("internal launch check order drifted")

    validator = {
        "name": "verify-benchmark-launch",
        "version": VERSION,
        "scriptSHA256": script_hash(),
        "manifestSHA256": file_hash(manifest_path),
    }
    protocol = {
        "protocolVersion": "benchmark-launch-v1",
        "runner": {
            "repository": repo,
            "revision": revision,
            "entrypoint": str(runner["entrypoint"]),
            "commandSHA256": command_hash,
            "environmentSHA256": environment_hash,
        },
        "dataset": {
            "name": dataset_name,
            "source": dataset_source,
            "revision": dataset_revision,
            "manifestSHA256": dataset_hash,
        },
        "taskManifestSHA256": task_hash,
        "evaluatorSHA256": evaluator_hash,
        "validatorSHA256": validator["scriptSHA256"],
        "baseline": {
            "name": baseline_name,
            "artifactSHA256": baseline_hash,
            "expectedScore": float(expected),
            "tolerance": float(tolerance),
        },
    }
    if recipe_hash is not None and driver_hash is not None:
        protocol["runner"]["recipeSHA256"] = recipe_hash
        protocol["runner"]["driverSHA256"] = driver_hash
    report = {
        "schemaVersion": 1,
        "protocol": protocol,
        "validator": validator,
        "checks": checks,
        "baselineScore": observed,
        "status": "passed" if not failures else "failed",
        "failures": failures,
        "evidence": [f"launch-manifest-sha256:{validator['manifestSHA256']}"],
    }
    if args.output:
        write(Path(args.output).expanduser().resolve(), report, args.force)
    print(json.dumps(report, sort_keys=True))
    return 0 if report["status"] == "passed" else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    boundary = commands.add_parser("probe-boundary")
    boundary.add_argument("--agent-root", required=True)
    boundary.add_argument("--hidden-path", action="append", required=True)
    boundary.add_argument("--output", required=True)
    boundary.add_argument("--force", action="store_true")
    launch = commands.add_parser("validate")
    launch.add_argument("manifest")
    launch.add_argument("--output")
    launch.add_argument("--force", action="store_true")
    args = parser.parse_args()
    return probe(args) if args.command == "probe-boundary" else validate(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        raise SystemExit(2)
