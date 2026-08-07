#!/usr/bin/env python3
"""Build evaluator-owned OpenScience evolutionary source provenance."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from collections import Counter
from pathlib import Path, PurePosixPath
from typing import Any


HASH = set("0123456789abcdef")
ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "references" / "manifest-schema.json"
ALGORITHM = "sha256-exact-line-v1"


class Invalid(ValueError):
    pass


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def hash_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_hash(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and set(value) <= HASH


def obj(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise Invalid(f"{label} must be a JSON object")
    return value


def text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise Invalid(f"{label} must be a non-empty string")
    return value


def digest(value: Any, label: str) -> str:
    if not is_hash(value):
        raise Invalid(f"{label} must be a lowercase SHA-256")
    return value


def integer(value: Any, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise Invalid(f"{label} must be an integer >= {minimum}")
    return value


def load(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise Invalid(f"cannot read {label} {path}: {exc}") from exc


def artifact(value: Any, label: str) -> dict[str, str]:
    item = obj(value, label)
    return {
        "uri": text(item.get("uri"), f"{label}.uri"),
        "sha256": digest(item.get("sha256"), f"{label}.sha256"),
    }


def relative(value: Any, label: str, dot: bool = False) -> str:
    item = text(value, label)
    if dot and item == ".":
        return item
    pure = PurePosixPath(item)
    if (
        pure.is_absolute()
        or "\\" in item
        or item.endswith("/")
        or any(part in {"", ".", ".."} for part in item.split("/"))
    ):
        raise Invalid(f"{label} must be a normalized relative POSIX path")
    return item


def contract(path: Path) -> dict[str, Any]:
    value = obj(load(path, "contract"), "contract")
    if value.get("protocolVersion") != "evolution-trace-v1":
        raise Invalid("contract.protocolVersion must be evolution-trace-v1")
    if digest(value.get("validatorSHA256"), "contract.validatorSHA256") != sha(Path(__file__).resolve()):
        raise Invalid("contract validatorSHA256 does not match this exact script")
    if digest(value.get("manifestSchemaSHA256"), "contract.manifestSchemaSHA256") != sha(SCHEMA):
        raise Invalid("contract manifestSchemaSHA256 does not match the bundled schema")
    if value.get("lineAlgorithm") != ALGORITHM:
        raise Invalid(f"contract.lineAlgorithm must be {ALGORITHM}")
    roots = value.get("roots")
    if not isinstance(roots, list) or not roots or len(roots) > 32:
        raise Invalid("contract.roots must contain 1 to 32 paths")
    value["roots"] = [relative(item, "contract root", dot=True) for item in roots]
    if len(set(value["roots"])) != len(value["roots"]):
        raise Invalid("contract.roots must be unique")
    extensions = value.get("extensions")
    if not isinstance(extensions, list) or not extensions or len(extensions) > 128:
        raise Invalid("contract.extensions must contain 1 to 128 suffixes")
    if any(not isinstance(item, str) or not re.fullmatch(r"\.[a-zA-Z0-9][a-zA-Z0-9._+-]{0,31}", item) for item in extensions):
        raise Invalid("contract.extensions must contain extension suffixes")
    if len(set(extensions)) != len(extensions):
        raise Invalid("contract.extensions must be unique")
    excluded = value.get("exclude", [])
    if not isinstance(excluded, list) or len(excluded) > 128:
        raise Invalid("contract.exclude must contain at most 128 paths")
    value["exclude"] = [relative(item, "contract exclusion", dot=True) for item in excluded]
    if len(set(value["exclude"])) != len(value["exclude"]):
        raise Invalid("contract.exclude must be unique")
    limits = {
        "maxFiles": (1, 100_000),
        "maxFileBytes": (1, 1_000_000_000),
        "maxTotalBytes": (1, 10_000_000_000),
        "maxSourceLines": (1, 10_000_000),
        "maxChangedLines": (1, 2_000_000),
    }
    for key, bounds in limits.items():
        amount = integer(value.get(key), f"contract.{key}", bounds[0])
        if amount > bounds[1]:
            raise Invalid(f"contract.{key} must be <= {bounds[1]}")
    if value["maxFileBytes"] > value["maxTotalBytes"]:
        raise Invalid("contract.maxFileBytes cannot exceed maxTotalBytes")
    return value


def excluded(path: str, protocol: dict[str, Any]) -> bool:
    return any(item == "." or path == item or path.startswith(f"{item}/") for item in protocol["exclude"])


def source(root: Path, protocol: dict[str, Any]) -> dict[str, Any]:
    if root.is_symlink():
        raise Invalid(f"candidate root is a symlink: {root}")
    if not root.is_dir():
        raise Invalid(f"candidate root is not a directory: {root}")
    base = root.resolve()
    paths: dict[str, Path] = {}
    for name in protocol["roots"]:
        target = base if name == "." else base / name
        if target.is_symlink():
            raise Invalid(f"source root is a symlink: {name}")
        if not target.is_dir():
            raise Invalid(f"source root does not exist: {name}")
        for path in target.rglob("*"):
            item = path.relative_to(base).as_posix()
            if excluded(item, protocol):
                continue
            if path.is_symlink():
                raise Invalid(f"source tree contains a symlink: {item}")
            if not path.is_file() or not any(item.endswith(extension) for extension in protocol["extensions"]):
                continue
            paths[item] = path
    if not paths:
        raise Invalid("source roots contain no files with a committed extension")
    if len(paths) > protocol["maxFiles"]:
        raise Invalid("source snapshot exceeds contract.maxFiles")
    files = []
    total_bytes = 0
    total_lines = 0
    for name, path in sorted(paths.items()):
        data = path.read_bytes()
        try:
            data.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise Invalid(f"source file is not valid UTF-8: {name}") from exc
        if len(data) > protocol["maxFileBytes"]:
            raise Invalid(f"source file exceeds contract.maxFileBytes: {name}")
        hashes = [hash_bytes(line) for line in data.split(b"\n") if line]
        total_bytes += len(data)
        total_lines += len(hashes)
        files.append({"path": name, "sha256": hash_bytes(data), "bytes": len(data), "lineHashes": hashes})
    if total_bytes > protocol["maxTotalBytes"]:
        raise Invalid("source snapshot exceeds contract.maxTotalBytes")
    if total_lines > protocol["maxSourceLines"]:
        raise Invalid("source snapshot exceeds contract.maxSourceLines")
    return {"schemaVersion": 1, "lineAlgorithm": ALGORITHM, "files": files}


def counts(manifest: dict[str, Any]) -> Counter[str]:
    return Counter(line for file in manifest["files"] for line in file["lineHashes"])


def expanded(left: Counter[str], right: Counter[str]) -> list[str]:
    return [item for item in sorted(left) for _ in range(max(0, left[item] - right[item]))]


def delta(parent: dict[str, Any], candidate: dict[str, Any], parent_id: str, parent_artifact: str, candidate_id: str, candidate_artifact: str) -> dict[str, Any]:
    before = {item["path"]: item for item in parent["files"]}
    after = {item["path"]: item for item in candidate["files"]}
    files = []
    for name in sorted(set(before) | set(after)):
        prior = before.get(name)
        current = after.get(name)
        if prior and current and prior["sha256"] == current["sha256"]:
            continue
        if prior is None:
            files.append({"path": name, "status": "added", "afterSHA256": current["sha256"]})
            continue
        if current is None:
            files.append({"path": name, "status": "deleted", "beforeSHA256": prior["sha256"]})
            continue
        files.append(
            {
                "path": name,
                "status": "modified",
                "beforeSHA256": prior["sha256"],
                "afterSHA256": current["sha256"],
            }
        )
    prior_lines = counts(parent)
    current_lines = counts(candidate)
    return {
        "schemaVersion": 1,
        "parent": {
            "id": parent_id,
            "artifactSHA256": parent_artifact,
            "snapshotSHA256": hash_bytes(canonical(parent)),
        },
        "candidate": {
            "id": candidate_id,
            "artifactSHA256": candidate_artifact,
            "snapshotSHA256": hash_bytes(canonical(candidate)),
        },
        "files": files,
        "addedLineHashes": expanded(current_lines, prior_lines),
        "deletedLineHashes": expanded(prior_lines, current_lines),
    }


def subject(path: Path) -> dict[str, Any]:
    value = obj(load(path, "subject"), "subject")
    if value.get("type") != "candidate":
        raise Invalid("subject.type must be candidate")
    return {
        "type": "candidate",
        "id": digest(value.get("id"), "subject.id"),
        "artifact": artifact(value.get("artifact"), "subject.artifact"),
    }


def parent(path: Path) -> dict[str, Any]:
    value = obj(load(path, "parent"), "parent")
    return {
        "id": digest(value.get("id"), "parent.id"),
        "artifact": artifact(value.get("artifact"), "parent.artifact"),
        "receiptID": digest(value.get("receiptID"), "parent.receiptID"),
        "snapshot": artifact(value.get("snapshot"), "parent.snapshot"),
        "root": Path(text(value.get("root"), "parent.root")),
        "deltaURI": value.get("deltaURI"),
    }


def build(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any]]:
    protocol = contract(args.contract)
    target = subject(args.subject)
    parents = [parent(path) for path in args.parent]
    if len(parents) > 2 or len({item["id"] for item in parents}) != len(parents):
        raise Invalid("parents must contain at most two unique candidate IDs")
    parents.sort(key=lambda item: item["id"])
    manifest = source(args.candidate_root, protocol)
    args.artifact_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = args.artifact_dir / "candidate.manifest.json"
    manifest_bytes = canonical(manifest)
    manifest_path.write_bytes(manifest_bytes)
    snapshot_uri = args.snapshot_uri or str(manifest_path.resolve())
    captures = []
    changes = []
    for item in parents:
        prior = source(item["root"], protocol)
        prior_sha = hash_bytes(canonical(prior))
        if prior_sha != item["snapshot"]["sha256"]:
            raise Invalid(f"local parent {item['id']} does not match its immutable snapshot")
        payload = delta(
            prior,
            manifest,
            item["id"],
            item["artifact"]["sha256"],
            target["id"],
            target["artifact"]["sha256"],
        )
        changed = len(payload["addedLineHashes"]) + len(payload["deletedLineHashes"])
        if changed > protocol["maxChangedLines"]:
            raise Invalid(f"delta against parent {item['id']} exceeds contract.maxChangedLines")
        delta_path = args.artifact_dir / f"{item['id']}.delta.json"
        delta_bytes = canonical(payload)
        delta_path.write_bytes(delta_bytes)
        delta_uri = item["deltaURI"] or str(delta_path.resolve())
        captures.append(
            {
                "id": item["id"],
                "artifact": item["artifact"],
                "receiptID": item["receiptID"],
                "snapshotSHA256": prior_sha,
                "delta": {"uri": delta_uri, "sha256": hash_bytes(delta_bytes)},
            }
        )
        changes.append(
            {
                "id": item["id"],
                "filesChanged": len(payload["files"]),
                "addedLines": len(payload["addedLineHashes"]),
                "deletedLines": len(payload["deletedLineHashes"]),
            }
        )
    at = args.evaluated_at or int(time.time() * 1000)
    evidence = sorted(
        set(args.evidence or [f"artifact:{snapshot_uri}", *[f"artifact:{item['delta']['uri']}" for item in captures]])
    )
    submission = {
        "schemaVersion": 1,
        "runID": args.run_id,
        "sessionID": args.session_id,
        "protocol": protocol,
        "subject": target,
        "snapshot": {
            "artifact": {"uri": snapshot_uri, "sha256": hash_bytes(manifest_bytes)},
            "schemaSHA256": protocol["manifestSchemaSHA256"],
            "files": manifest["files"],
        },
        "parents": captures,
        "validator": {
            "name": "trace-evolutionary-candidate",
            "version": 1,
            "scriptSHA256": sha(Path(__file__).resolve()),
        },
        "evidence": evidence,
        "evaluatedAt": at,
    }
    report = {
        "schemaVersion": 1,
        "submissionSHA256": hash_bytes(canonical(submission)),
        "snapshotSHA256": hash_bytes(manifest_bytes),
        "files": len(manifest["files"]),
        "bytes": sum(item["bytes"] for item in manifest["files"]),
        "sourceLines": sum(len(item["lineHashes"]) for item in manifest["files"]),
        "parents": changes,
        "note": "Preview only; the OpenScience backend derives authoritative ancestry and cycle diagnostics.",
    }
    return submission, report


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("commitments", help="print exact validator and manifest-schema SHA-256 commitments")
    command = commands.add_parser("build", help="build a token-free evolution trace submission")
    command.add_argument("--contract", type=Path, required=True)
    command.add_argument("--subject", type=Path, required=True)
    command.add_argument("--candidate-root", type=Path, required=True)
    command.add_argument("--parent", type=Path, action="append", default=[])
    command.add_argument("--artifact-dir", type=Path, required=True)
    command.add_argument("--snapshot-uri")
    command.add_argument("--run-id", required=True)
    command.add_argument("--session-id", required=True)
    command.add_argument("--evaluated-at", type=int)
    command.add_argument("--evidence", action="append")
    command.add_argument("--output", type=Path)
    command.add_argument("--report", type=Path)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "commitments":
            print(
                json.dumps(
                    {"validatorSHA256": sha(Path(__file__).resolve()), "manifestSchemaSHA256": sha(SCHEMA)},
                    sort_keys=True,
                )
            )
            return 0
        submission, report = build(args)
        rendered = json.dumps(submission, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
        if args.output:
            args.output.write_text(rendered, encoding="utf-8")
        else:
            sys.stdout.write(rendered)
        if args.report:
            args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return 0
    except (Invalid, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
