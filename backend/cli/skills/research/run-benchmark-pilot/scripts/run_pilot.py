#!/usr/bin/env python3
"""Preflight and execute a sealed OpenScience benchmark recipe v2 pilot."""

import argparse
import contextlib
import csv
import hashlib
import importlib
import importlib.util
import io
import json
import math
import os
import pickle
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path


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


def valid_hash(value: object, size: int = 64) -> bool:
    return isinstance(value, str) and len(value) == size and set(value) <= HEX


def mapping(value: object, name: str) -> dict:
    if not isinstance(value, dict):
        fail(f"{name} must be an object")
    return value


def array(value: object, name: str) -> list:
    if not isinstance(value, list):
        fail(f"{name} must be an array")
    return value


def text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value:
        fail(f"{name} must be a non-empty string")
    return value


def regular(path: Path, name: str) -> Path:
    if not path.is_file():
        fail(f"{name} is not a readable regular file")
    return path


def root(base: Path, value: object, name: str) -> Path:
    source = Path(text(value, name)).expanduser()
    return (source if source.is_absolute() else base / source).resolve()


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


def write(path: Path, value: object) -> None:
    if path.exists():
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


def git(workspace: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(workspace), *args], capture_output=True, text=True, timeout=20, check=False
    )
    if result.returncode:
        fail(f"git {' '.join(args)} failed")
    return result.stdout.strip()


def repository(value: str) -> str:
    result = value.strip().rstrip("/")
    return result[:-4] if result.endswith(".git") else result


def glob(root_: Path, pattern: str, name: str) -> list[Path]:
    if Path(pattern).is_absolute() or ".." in Path(pattern).parts or "\\" in pattern:
        fail(f"{name} must be a checkout-relative POSIX pattern")
    matches = sorted(root_.glob(pattern))
    for match in matches:
        try:
            match.resolve().relative_to(root_)
        except ValueError:
            fail(f"{name} resolves outside the checkout")
    return matches


def tree_hash(path: Path) -> str:
    if path.is_file():
        return file_hash(path)
    if not path.is_dir():
        fail(f"artifact disappeared: {path}")
    rows = []
    for item in sorted(value for value in path.rglob("*") if value.is_file()):
        rows.append({"path": item.relative_to(path).as_posix(), "sha256": file_hash(item)})
    return digest(rows)


def resolve(module: object, symbol: str) -> object:
    value = module
    for part in symbol.split("."):
        value = getattr(value, part)
    return value


def runtime_value(spec: dict, kind: str, base: Path) -> tuple[object, dict]:
    allowed = {
        "json": {"kind", "artifact", "sha256"},
        "python_object": {"kind", "source", "sha256", "symbol", "kwargs"},
        "callable": {"kind", "source", "sha256", "symbol"},
    }[kind]
    if set(spec) != allowed:
        fail(f"runtime {kind} input must contain exactly: {', '.join(sorted(allowed))}")
    if spec.get("kind") != kind:
        fail(f"runtime input kind must be {kind}")
    if kind == "json":
        artifact = regular(root(base, spec.get("artifact"), "runtime JSON artifact"), "runtime JSON artifact")
        expected = text(spec.get("sha256"), "runtime JSON sha256")
        if not valid_hash(expected) or file_hash(artifact) != expected:
            fail("runtime JSON artifact hash mismatch")
        return json.loads(artifact.read_text(encoding="utf-8")), {
            "kind": kind,
            "artifactSHA256": expected,
        }
    source = regular(root(base, spec.get("source"), "runtime Python source"), "runtime Python source")
    expected = text(spec.get("sha256"), "runtime Python sha256")
    if not valid_hash(expected) or file_hash(source) != expected:
        fail("runtime Python source hash mismatch")
    symbol = text(spec.get("symbol"), "runtime Python symbol")
    module_name = f"openscience_pilot_{file_hash(source)}"
    module_spec = importlib.util.spec_from_file_location(module_name, source)
    if module_spec is None or module_spec.loader is None:
        fail("runtime Python source cannot be imported")
    module = importlib.util.module_from_spec(module_spec)
    sys.path.insert(0, str(source.parent))
    module_spec.loader.exec_module(module)
    value = resolve(module, symbol)
    if kind == "python_object":
        kwargs = mapping(spec.get("kwargs", {}), "runtime Python kwargs")
        value = value(**kwargs)
    return value, {"kind": kind, "sourceSHA256": expected, "symbol": symbol}


def preflight(manifest_path: Path) -> dict:
    manifest = mapping(json.loads(regular(manifest_path, "pilot manifest").read_text(encoding="utf-8")), "manifest")
    allowed = {"schemaVersion", "workspace", "resultsRoot", "source", "recipe", "timeoutSeconds", "runtime"}
    if set(manifest) - allowed or not {"schemaVersion", "workspace", "resultsRoot", "source", "recipe", "runtime"} <= set(manifest):
        fail("pilot manifest fields do not match the schema")
    if manifest.get("schemaVersion") != 1:
        fail("pilot manifest schemaVersion must be 1")
    base = manifest_path.parent
    workspace = root(base, manifest.get("workspace"), "workspace")
    results = root(base, manifest.get("resultsRoot"), "resultsRoot")
    if not workspace.is_dir():
        fail("workspace must be an existing directory")
    if results == workspace or workspace in results.parents:
        fail("resultsRoot must be outside the benchmark checkout")
    if results.exists() and any(results.iterdir()):
        fail("resultsRoot must be absent or empty")

    source = mapping(manifest.get("source"), "source")
    if set(source) != {"repository", "revision"}:
        fail("source must contain exactly repository and revision")
    repo = text(source.get("repository"), "source.repository")
    revision = text(source.get("revision"), "source.revision")
    if len(revision) not in (40, 64) or set(revision) > HEX:
        fail("source.revision must be a 40- or 64-character lowercase hexadecimal revision")
    if git(workspace, "rev-parse", "HEAD") != revision:
        fail("checkout revision does not match the pilot source pin")
    if repository(git(workspace, "remote", "get-url", "origin")) != repository(repo):
        fail("checkout origin does not match the pilot source pin")
    if git(workspace, "status", "--porcelain", "--untracked-files=all"):
        fail("benchmark checkout must be clean")

    recipe_path = regular(root(base, manifest.get("recipe"), "recipe"), "materialized recipe")
    recipe = mapping(json.loads(recipe_path.read_text(encoding="utf-8")), "recipe")
    if recipe.get("schemaVersion") != 2:
        fail("materialized recipe schemaVersion must be 2")
    for field in ("recipeSHA256", "bindingsSHA256", "driverSHA256"):
        if not valid_hash(recipe.get(field)):
            fail(f"recipe.{field} must be a lowercase SHA-256")
    if digest(mapping(recipe.get("bindings"), "recipe.bindings")) != recipe["bindingsSHA256"]:
        fail("materialized recipe binding commitment is invalid")
    stages = array(recipe.get("stages"), "recipe.stages")
    launch = next((stage for stage in stages if isinstance(stage, dict) and stage.get("id") == recipe.get("launchStage")), None)
    if launch is None or digest(mapping(launch.get("driver"), "launch driver")) != recipe["driverSHA256"]:
        fail("materialized recipe launch-driver commitment is invalid")

    for anchor in array(recipe.get("anchors"), "recipe.anchors"):
        if not inside(workspace, anchor, "recipe anchor").exists():
            fail(f"recipe anchor is missing: {anchor}")
    environment = mapping(recipe.get("environment"), "recipe.environment")
    for filename in array(environment.get("files"), "recipe.environment.files"):
        regular(inside(workspace, filename, "environment file"), f"environment file {filename}")

    declared = mapping(manifest.get("runtime", {}), "runtime")
    expected_runtime = array(recipe.get("runtime"), "recipe.runtime")
    expected_names = sorted(text(item.get("name"), "runtime name") for item in expected_runtime if isinstance(item, dict))
    if sorted(declared) != expected_names:
        fail("pilot runtime inputs do not exactly match the materialized recipe")
    runtime = {}
    runtime_evidence = {}
    sys.path.insert(0, str(workspace))
    for item in expected_runtime:
        row = mapping(item, "runtime declaration")
        name = text(row.get("name"), "runtime name")
        runtime[name], runtime_evidence[name] = runtime_value(mapping(declared[name], name), text(row.get("kind"), "runtime kind"), base)

    missing_environment = []
    artifacts = array(recipe.get("artifacts"), "recipe.artifacts")
    for stage in stages:
        row = mapping(stage, "recipe stage")
        driver = mapping(row.get("driver"), "stage driver")
        regular(inside(workspace, driver.get("entrypoint"), "stage entrypoint"), f"entrypoint {driver.get('entrypoint')}")
        missing_environment.extend(
            name for name in array(row.get("environment"), "stage environment") if not os.environ.get(str(name))
        )
    if missing_environment:
        fail(f"required environment is missing: {', '.join(sorted(set(missing_environment)))}")
    for artifact in artifacts:
        row = mapping(artifact, "recipe artifact")
        if row.get("kind") == "file" and glob(workspace, text(row.get("path"), "artifact path"), "artifact path"):
            fail(f"artifact path is not clean before launch: {row.get('path')}")

    timeout = manifest.get("timeoutSeconds", 3600)
    if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout < 1 or timeout > 604800:
        fail("timeoutSeconds must be an integer from 1 to 604800")
    return {
        "manifest": manifest,
        "manifestPath": manifest_path,
        "manifestSHA256": file_hash(manifest_path),
        "workspace": workspace,
        "results": results,
        "source": {"repository": repo, "revision": revision},
        "recipePath": recipe_path,
        "recipeArtifactSHA256": file_hash(recipe_path),
        "recipe": recipe,
        "runtime": runtime,
        "runtimeEvidence": runtime_evidence,
        "timeout": timeout,
    }


def require_inputs(workspace: Path, patterns: list, stage: str) -> None:
    for pattern in patterns:
        if not glob(workspace, text(pattern, f"stage {stage} input"), f"stage {stage} input"):
            fail(f"stage {stage} input does not exist: {pattern}")


def require_outputs(workspace: Path, patterns: list, stage: str) -> None:
    for pattern in patterns:
        if not glob(workspace, text(pattern, f"stage {stage} output"), f"stage {stage} output"):
            fail(f"stage {stage} did not produce: {pattern}")


def json_values(value: object, path: str) -> list:
    if not path.startswith("$"):
        fail("JSON selector must start with $")
    values = [value]
    cursor = 1
    token = re.compile(r"\.([A-Za-z_][A-Za-z0-9_]*)|\[(\*|[0-9]+)\]")
    while cursor < len(path):
        match = token.match(path, cursor)
        if match is None:
            fail(f"unsupported JSON selector syntax at offset {cursor}")
        key, index = match.groups()
        if key:
            values = [mapping(item, "JSON selector value")[key] for item in values]
        elif index == "*":
            values = [child for item in values for child in array(item, "JSON selector array")]
        else:
            values = [array(item, "JSON selector array")[int(index)] for item in values]
        cursor = match.end()
    return values


def numbers(value: object) -> list[float]:
    if hasattr(value, "tolist"):
        return numbers(value.tolist())
    if isinstance(value, (list, tuple)):
        return [number for item in value for number in numbers(item)]
    if isinstance(value, bool):
        return [1.0 if value else 0.0]
    if isinstance(value, (int, float)) and math.isfinite(value):
        return [float(value)]
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("true", "yes", "pass", "passed"):
            return [1.0]
        if lowered in ("false", "no", "fail", "failed"):
            return [0.0]
        try:
            number = float(lowered)
        except ValueError:
            fail(f"metric value is not numeric: {value}")
        if math.isfinite(number):
            return [number]
    fail("metric value is not finite numeric data")


def select(path: Path, format_: str, selector: dict) -> list[float]:
    kind = selector.get("kind")
    if kind == "jsonpath":
        if format_ == "pickle":
            with path.open("rb") as handle:
                value = pickle.load(handle)
        else:
            value = json.loads(path.read_text(encoding="utf-8"))
        return numbers(json_values(value, text(selector.get("path"), "JSON selector")))
    if kind == "jsonlpath":
        rows = path.read_text(encoding="utf-8").splitlines()
        if not rows or any(not row.strip() for row in rows):
            fail("JSONL metric artifact must contain only non-empty records")
        values = [json.loads(row) for row in rows]
        selected = [
            item
            for value in values
            for item in json_values(value, text(selector.get("path"), "JSONL selector"))
        ]
        return numbers(selected)
    if kind == "column":
        with path.open("r", encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
        name = text(selector.get("name"), "column selector")
        if any(name not in row for row in rows):
            fail(f"metric column does not exist: {name}")
        return numbers([row[name] for row in rows])
    if kind == "tuple":
        with path.open("rb") as handle:
            value = pickle.load(handle)
        return numbers(array(list(value), "pickle tuple")[int(selector.get("index"))])
    if kind == "ratio_line":
        prefix = text(selector.get("prefix"), "ratio prefix")
        lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.startswith(prefix)]
        if len(lines) != 1:
            fail(f"expected exactly one ratio line for {prefix}")
        match = re.fullmatch(rf"{re.escape(prefix)}\s*([0-9]+)\s*/\s*([1-9][0-9]*)", lines[0])
        if not match:
            fail(f"invalid ratio line for {prefix}")
        return [int(match.group(1)) / int(match.group(2))]
    fail(f"unsupported metric selector: {kind}")


def aggregate(values: list[float], method: str) -> float:
    if not values:
        fail("metric selector returned no values")
    if method == "identity":
        if len(values) != 1:
            fail("identity aggregation requires exactly one value")
        return values[0]
    if method == "mean":
        return sum(values) / len(values)
    if method == "sum":
        return sum(values)
    if method == "count":
        return float(len(values))
    fail(f"unsupported metric aggregation: {method}")


@contextlib.contextmanager
def deadline(seconds: int):
    if not hasattr(signal, "SIGALRM"):
        yield
        return

    def timeout(_signum, _frame):
        raise TimeoutError(f"Python stage exceeded {seconds} seconds")

    previous = signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def execute(state: dict) -> dict:
    workspace = state["workspace"]
    results = state["results"]
    results.mkdir(parents=True, exist_ok=True)
    recipe = state["recipe"]
    values = dict(state["runtime"])
    returns = {}
    records = []
    started = int(time.time() * 1000)
    sys.path.insert(0, str(workspace))
    for index, stage in enumerate(recipe["stages"]):
        identifier = text(stage.get("id"), "stage id")
        require_inputs(workspace, array(stage.get("inputs"), "stage inputs"), identifier)
        driver = mapping(stage.get("driver"), "stage driver")
        begin = int(time.time() * 1000)
        record = {"id": identifier, "driver": driver.get("kind"), "startedAt": begin}
        if driver.get("kind") == "argv":
            cwd = inside(workspace, driver.get("cwd"), "stage cwd") if driver.get("cwd") != "." else workspace
            argv = array(driver.get("argv"), "stage argv")
            if any(not isinstance(item, str) or not item for item in argv):
                fail(f"stage {identifier} argv must contain non-empty strings")
            outcome = subprocess.run(
                argv,
                cwd=cwd,
                capture_output=True,
                timeout=state["timeout"],
                check=False,
            )
            stdout = results / f"{index:02d}-{identifier}.stdout"
            stderr = results / f"{index:02d}-{identifier}.stderr"
            stdout.write_bytes(outcome.stdout)
            stderr.write_bytes(outcome.stderr)
            record.update(
                {
                    "exitCode": outcome.returncode,
                    "stdoutSHA256": file_hash(stdout),
                    "stderrSHA256": file_hash(stderr),
                }
            )
            if outcome.returncode:
                fail(f"stage {identifier} exited with {outcome.returncode}")
        elif driver.get("kind") == "python_api":
            module = importlib.import_module(text(driver.get("module"), "Python module"))
            receiver = driver.get("receiver")
            function = (
                getattr(values[text(receiver, "Python receiver")], text(driver.get("symbol"), "Python symbol").split(".")[-1])
                if receiver
                else resolve(module, text(driver.get("symbol"), "Python symbol"))
            )
            kwargs = dict(mapping(driver.get("kwargs"), "Python kwargs"))
            for parameter, name in mapping(driver.get("arguments"), "Python arguments").items():
                if parameter in kwargs:
                    fail(f"Python parameter is bound twice: {parameter}")
                kwargs[parameter] = values[text(name, "Python value")]
            output = io.StringIO()
            errors = io.StringIO()
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors), deadline(state["timeout"]):
                value = function(**kwargs)
            stdout = results / f"{index:02d}-{identifier}.stdout"
            stderr = results / f"{index:02d}-{identifier}.stderr"
            stdout.write_text(output.getvalue(), encoding="utf-8")
            stderr.write_text(errors.getvalue(), encoding="utf-8")
            if stage.get("produces"):
                values[text(stage.get("produces"), "stage produces")] = value
            record.update(
                {
                    "returnType": type(value).__name__,
                    "stdoutSHA256": file_hash(stdout),
                    "stderrSHA256": file_hash(stderr),
                }
            )
        else:
            fail(f"unsupported stage driver: {driver.get('kind')}")
        require_outputs(workspace, array(stage.get("outputs"), "stage outputs"), identifier)
        record["completedAt"] = int(time.time() * 1000)
        records.append(record)

    artifact_records = []
    artifact_paths = {}
    for artifact in recipe["artifacts"]:
        identifier = text(artifact.get("id"), "artifact id")
        if artifact.get("kind") == "return":
            name = text(artifact.get("value"), "return artifact value")
            target = results / "returns" / f"{identifier}.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(canonical(values[name]) + b"\n")
            returns[identifier] = target
            artifact_paths[identifier] = [target]
            artifact_records.append({"id": identifier, "kind": "return", "sha256": file_hash(target)})
            continue
        paths = glob(workspace, text(artifact.get("path"), "artifact path"), "artifact path")
        cardinality = mapping(artifact.get("cardinality"), "artifact cardinality")
        if len(paths) < cardinality.get("minimum", 0) or len(paths) > cardinality.get("maximum", 0):
            fail(f"artifact {identifier} matched {len(paths)} paths outside its cardinality")
        artifact_paths[identifier] = paths
        artifact_records.append(
            {
                "id": identifier,
                "kind": "file",
                "paths": [
                    {"path": path.relative_to(workspace).as_posix(), "sha256": tree_hash(path)} for path in paths
                ],
            }
        )

    metrics = {}
    for metric in recipe["metrics"]:
        artifact = next(item for item in recipe["artifacts"] if item["id"] == metric["artifact"])
        values_ = [
            value
            for path in artifact_paths[metric["artifact"]]
            for value in select(path, artifact["format"], mapping(metric.get("selector"), "metric selector"))
        ]
        metrics[metric["name"]] = aggregate(values_, text(metric.get("aggregation"), "metric aggregation"))

    payload = {
        "schemaVersion": 1,
        "status": "passed",
        "pilotID": digest(
            {
                "manifestSHA256": state["manifestSHA256"],
                "recipeArtifactSHA256": state["recipeArtifactSHA256"],
                "source": state["source"],
            }
        ),
        "source": state["source"],
        "recipe": {
            "artifactSHA256": state["recipeArtifactSHA256"],
            "recipeSHA256": recipe["recipeSHA256"],
            "bindingsSHA256": recipe["bindingsSHA256"],
            "driverSHA256": recipe["driverSHA256"],
        },
        "runtime": state["runtimeEvidence"],
        "startedAt": started,
        "completedAt": int(time.time() * 1000),
        "stages": records,
        "artifacts": artifact_records,
        "metrics": metrics,
    }
    return {**payload, "receiptSHA256": digest(payload)}


def main() -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("preflight", "run"):
        command = commands.add_parser(name)
        command.add_argument("manifest")
        command.add_argument("--output", required=True)
    args = parser.parse_args()
    manifest = Path(args.manifest).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    state = preflight(manifest)
    if output == state["workspace"] or state["workspace"] in output.parents:
        fail("pilot output must be outside the benchmark checkout")
    if args.command == "preflight":
        payload = {
            "schemaVersion": 1,
            "status": "passed",
            "validator": {"name": "run-benchmark-pilot", "version": VERSION, "scriptSHA256": file_hash(Path(__file__))},
            "manifestSHA256": state["manifestSHA256"],
            "recipeArtifactSHA256": state["recipeArtifactSHA256"],
            "source": state["source"],
            "runtime": state["runtimeEvidence"],
        }
        write(output, {**payload, "preflightSHA256": digest(payload)})
        print(json.dumps({"status": "passed", "output": str(output)}))
        return 0
    receipt = execute(state)
    write(output, receipt)
    print(json.dumps({"status": "passed", "receiptID": receipt["receiptSHA256"], "output": str(output)}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, IndexError, TypeError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}), file=sys.stderr)
        raise SystemExit(1)
