#!/usr/bin/env python3
"""Validate and build evaluator-owned OpenScience intervention plans."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
FAMILIES = {
    "replay",
    "retune",
    "ablation",
    "repair",
    "model_transfer",
    "context_transfer",
    "evaluator_transfer",
    "split_transfer",
}
MODES = {
    "replay": "max_absolute_effect",
    "retune": "min_effect",
    "ablation": "min_effect",
    "repair": "min_effect",
    "model_transfer": "max_regression",
    "context_transfer": "max_regression",
    "evaluator_transfer": "max_regression",
    "split_transfer": "max_regression",
}
HASH = set("0123456789abcdef")


class Invalid(ValueError):
    pass


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def file_sha(path: Path) -> str:
    return sha(path.read_bytes())


def load(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise Invalid(f"cannot read {label} {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise Invalid(f"{label} must be a JSON object")
    return value


def text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise Invalid(f"{label} must be a non-empty string")
    return value


def digest(value: Any, label: str) -> str:
    item = text(value, label)
    if len(item) != 64 or set(item) - HASH:
        raise Invalid(f"{label} must be a lowercase SHA-256")
    return item


def integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise Invalid(f"{label} must be an integer from {minimum} to {maximum}")
    return value


def artifact(value: Any, label: str) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"uri", "sha256"}:
        raise Invalid(f"{label} must contain only uri and sha256")
    return {"uri": text(value.get("uri"), f"{label}.uri"), "sha256": digest(value.get("sha256"), f"{label}.sha256")}


def protocol(path: Path) -> dict[str, Any]:
    value = load(path, "contract")
    expected = {
        "protocolVersion",
        "validatorSHA256",
        "requiredForPromotion",
        "minPairs",
        "maxPairs",
        "maxTotalPairs",
        "confidence",
        "required",
        "rules",
    }
    if set(value) != expected:
        raise Invalid(f"contract must contain exactly {sorted(expected)}")
    if value.get("protocolVersion") != "intervention-study-v1":
        raise Invalid("contract.protocolVersion must be intervention-study-v1")
    if digest(value.get("validatorSHA256"), "contract.validatorSHA256") != file_sha(Path(__file__).resolve()):
        raise Invalid("contract validatorSHA256 does not match this exact script")
    if value.get("confidence") != 0.95:
        raise Invalid("contract.confidence must be 0.95")
    if not isinstance(value.get("requiredForPromotion"), bool):
        raise Invalid("contract.requiredForPromotion must be boolean")
    minimum = integer(value.get("minPairs"), "contract.minPairs", 3, 32)
    maximum = integer(value.get("maxPairs"), "contract.maxPairs", 3, 32)
    total = integer(value.get("maxTotalPairs"), "contract.maxTotalPairs", 3, 256)
    if minimum > maximum:
        raise Invalid("contract.maxPairs cannot be smaller than minPairs")
    required = value.get("required")
    if not isinstance(required, list) or not required or any(item not in FAMILIES for item in required):
        raise Invalid("contract.required must contain known intervention families")
    if required != sorted(set(required)):
        raise Invalid("contract.required must be unique and sorted")
    rules = value.get("rules")
    if not isinstance(rules, list) or len(rules) != len(required):
        raise Invalid("contract.rules must cover every required family exactly once")
    seen = []
    for rule in rules:
        if not isinstance(rule, dict) or set(rule) != {"family", "mode", "threshold"}:
            raise Invalid("each contract rule must contain family, mode, and threshold")
        family = rule.get("family")
        if family not in required or rule.get("mode") != MODES[family]:
            raise Invalid(f"contract rule mode is invalid for {family}")
        threshold = rule.get("threshold")
        if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not math.isfinite(threshold):
            raise Invalid(f"contract rule threshold is invalid for {family}")
        if threshold < 0:
            raise Invalid(f"contract rule threshold must be nonnegative for {family}")
        seen.append(family)
    if seen != required:
        raise Invalid("contract.rules must be family-sorted and match required")
    if maximum * len(required) > total:
        raise Invalid("contract.maxTotalPairs cannot fit every required family")
    return value


def model(value: Any, label: str) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"provider", "name", "version"}:
        raise Invalid(f"{label} must contain provider, name, and version")
    return {key: text(value.get(key), f"{label}.{key}") for key in ["provider", "name", "version"]}


def evaluator(value: Any, label: str) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"name", "version", "source"}:
        raise Invalid(f"{label} must contain name, version, and source")
    source = value.get("source")
    if source not in {"benchmark", "gate", "external"}:
        raise Invalid(f"{label}.source is invalid")
    return {"name": text(value.get("name"), f"{label}.name"), "version": text(value.get("version"), f"{label}.version"), "source": source}


def target(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"artifact", "condition"}:
        raise Invalid(f"{label} must contain artifact and condition")
    condition = value.get("condition")
    expected = {"seed", "model", "context", "evaluator", "split", "environment", "budget"}
    if not isinstance(condition, dict) or set(condition) != expected:
        raise Invalid(f"{label}.condition must contain exactly {sorted(expected)}")
    split = condition.get("split")
    if not isinstance(split, dict) or set(split) != {"name", "manifest"}:
        raise Invalid(f"{label}.condition.split must contain name and manifest")
    return {
        "artifact": artifact(value.get("artifact"), f"{label}.artifact"),
        "condition": {
            "seed": integer(condition.get("seed"), f"{label}.condition.seed", -(2**53), 2**53),
            "model": model(condition.get("model"), f"{label}.condition.model"),
            "context": artifact(condition.get("context"), f"{label}.condition.context"),
            "evaluator": evaluator(condition.get("evaluator"), f"{label}.condition.evaluator"),
            "split": {
                "name": text(split.get("name"), f"{label}.condition.split.name"),
                "manifest": artifact(split.get("manifest"), f"{label}.condition.split.manifest"),
            },
            "environment": artifact(condition.get("environment"), f"{label}.condition.environment"),
            "budget": artifact(condition.get("budget"), f"{label}.condition.budget"),
        },
    }


def changes(control: dict[str, Any], arm: dict[str, Any]) -> list[str]:
    fields = ["artifact", "model", "context", "evaluator", "split", "environment", "budget", "seed"]
    result = []
    for field in fields:
        left = control["artifact"] if field == "artifact" else control["condition"][field]
        right = arm["artifact"] if field == "artifact" else arm["condition"][field]
        if left != right:
            result.append(field)
    return result


def pair(value: Any, subject_artifact: dict[str, str], label: str) -> dict[str, Any]:
    expected = {"family", "index", "control", "arm", "change"}
    if not isinstance(value, dict) or set(value) != expected:
        raise Invalid(f"{label} must contain exactly {sorted(expected)}")
    family = value.get("family")
    if family not in FAMILIES:
        raise Invalid(f"{label}.family is invalid")
    control = target(value.get("control"), f"{label}.control")
    arm = target(value.get("arm"), f"{label}.arm")
    changed = changes(control, arm)
    if family == "replay":
        if changed or arm["artifact"] != subject_artifact:
            raise Invalid(f"{label}: replay must repeat the exact study subject and condition")
    elif family in {"retune", "ablation", "repair"}:
        if changed != ["artifact"] or arm["artifact"] != subject_artifact:
            raise Invalid(f"{label}: {family} may change only the artifact and its arm must be the study subject")
    else:
        field = family.removesuffix("_transfer")
        if changed != [field] or control["artifact"] != subject_artifact or arm["artifact"] != subject_artifact:
            raise Invalid(f"{label}: {family} may change only {field} while evaluating the study subject")
    return {
        "family": family,
        "index": integer(value.get("index"), f"{label}.index", 0, 31),
        "control": control,
        "arm": arm,
        "change": artifact(value.get("change"), f"{label}.change"),
    }


def build(contract_path: Path, spec_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    frozen = protocol(contract_path)
    spec = load(spec_path, "spec")
    expected = {"schemaVersion", "runID", "sessionID", "subject", "evolutionReceiptID", "pairs"}
    if set(spec) != expected:
        raise Invalid(f"spec must contain exactly {sorted(expected)}")
    if spec.get("schemaVersion") != 1:
        raise Invalid("spec.schemaVersion must be 1")
    subject = spec.get("subject")
    if not isinstance(subject, dict) or set(subject) != {"type", "id", "artifact"} or subject.get("type") != "candidate":
        raise Invalid("spec.subject must be an exact candidate subject")
    candidate = {
        "type": "candidate",
        "id": digest(subject.get("id"), "spec.subject.id"),
        "artifact": artifact(subject.get("artifact"), "spec.subject.artifact"),
    }
    values = spec.get("pairs")
    if not isinstance(values, list):
        raise Invalid("spec.pairs must be an array")
    pairs = [pair(value, candidate["artifact"], f"spec.pairs[{index}]") for index, value in enumerate(values)]
    pairs.sort(key=lambda item: (item["family"], item["index"]))
    if len({sha(canonical(item)) for item in pairs}) != len(pairs):
        raise Invalid("spec.pairs must be unique")
    families = sorted({item["family"] for item in pairs})
    if families != frozen["required"]:
        raise Invalid("spec.pairs must cover exactly the required families")
    for family in families:
        items = [item for item in pairs if item["family"] == family]
        if not frozen["minPairs"] <= len(items) <= frozen["maxPairs"]:
            raise Invalid(f"{family} violates the frozen pair bounds")
        if [item["index"] for item in items] != list(range(len(items))):
            raise Invalid(f"{family} indexes must be contiguous from zero")
    if len(pairs) > frozen["maxTotalPairs"]:
        raise Invalid("spec.pairs exceeds contract.maxTotalPairs")
    request = {
        "schemaVersion": 1,
        "runID": text(spec.get("runID"), "spec.runID"),
        "sessionID": text(spec.get("sessionID"), "spec.sessionID"),
        "subject": candidate,
        "evolutionReceiptID": digest(spec.get("evolutionReceiptID"), "spec.evolutionReceiptID"),
        "validator": {
            "name": "design-replay-interventions",
            "version": 1,
            "scriptSHA256": file_sha(Path(__file__).resolve()),
        },
        "pairs": pairs,
    }
    report = {
        "schemaVersion": 1,
        "candidateID": candidate["id"],
        "families": {family: len([item for item in pairs if item["family"] == family]) for family in families},
        "targets": [
            {
                "family": item["family"],
                "index": item["index"],
                "controlSHA256": sha(canonical(item["control"])),
                "armSHA256": sha(canonical(item["arm"])),
                "changeSHA256": item["change"]["sha256"],
            }
            for item in pairs
        ],
    }
    return request, report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("commitments")
    builder = commands.add_parser("build")
    builder.add_argument("--contract", type=Path, required=True)
    builder.add_argument("--spec", type=Path, required=True)
    builder.add_argument("--output", type=Path, required=True)
    builder.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "commitments":
        print(json.dumps({"validatorSHA256": file_sha(Path(__file__).resolve())}, sort_keys=True))
        return 0
    request, report = build(args.contract, args.spec)
    args.output.write_bytes(canonical(request) + b"\n")
    args.report.write_bytes(canonical(report) + b"\n")
    print(json.dumps({"output": str(args.output), "report": str(args.report), "pairs": len(request["pairs"])}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Invalid as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        raise SystemExit(2) from exc
