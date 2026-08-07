#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
from pathlib import Path


HASH = 64


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def load(path: str) -> dict:
    value = json.loads(Path(path).read_text())
    require(isinstance(value, dict), f"{path} must contain one JSON object")
    return value


def exact(value: dict, name: str, allowed: set[str], required: set[str]) -> None:
    require(set(value) <= allowed, f"{name} has unknown fields: {sorted(set(value) - allowed)}")
    require(required <= set(value), f"{name} is missing fields: {sorted(required - set(value))}")


def sha(value: object) -> str:
    data = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(data).hexdigest()


def valid_hash(value: object) -> bool:
    return isinstance(value, str) and len(value) == HASH and all(char in "0123456789abcdef" for char in value)


def secrets(value: object, location: str = "$") -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = key.lower().replace("_", "").replace("-", "")
            require(
                not any(word in normalized for word in ("token", "secret", "apikey")),
                f"secret field at {location}.{key}",
            )
            require(key not in {"feedback", "notes"}, f"forbidden claim field at {location}.{key}")
            secrets(item, f"{location}.{key}")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            secrets(item, f"{location}[{index}]")


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate a token-free sealed confirmation result")
    parser.add_argument("--protocol", required=True)
    parser.add_argument("--selection", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    protocol = load(args.protocol)
    selection = load(args.selection)
    result = load(args.result)
    secrets(protocol)
    secrets(selection)
    secrets(result)

    exact(
        protocol,
        "protocol",
        {"protocolVersion", "optimization", "claim", "selection", "exposure", "failurePolicy"},
        {"protocolVersion", "optimization", "claim", "selection", "exposure", "failurePolicy"},
    )
    require(protocol["protocolVersion"] == "sealed-confirmation-v1", "unsupported protocol version")
    require(protocol["optimization"]["split"] in {"development", "validation"}, "invalid optimization split")
    require(protocol["claim"]["split"] in {"held_out", "release"}, "invalid claim split")
    require(
        protocol["optimization"]["manifestSHA256"] != protocol["claim"]["manifestSHA256"],
        "manifests must differ",
    )
    require(
        protocol["selection"] == {"rule": "terminal-verified-best-v1", "subjects": 1},
        "invalid selection policy",
    )
    require(
        protocol["exposure"]
        == {"policy": "terminal-receipt-only", "searchFeedback": False, "memoryCapture": False},
        "invalid exposure policy",
    )
    require(protocol["failurePolicy"] == "fail-closed", "confirmation must fail closed")
    for key in ("manifestSHA256", "validatorSHA256", "environmentSHA256"):
        require(valid_hash(protocol["claim"][key]), f"claim.{key} must be a lowercase SHA-256")

    fields = {
        "schemaVersion",
        "protocolVersion",
        "selectionID",
        "contractSHA256",
        "protocolSHA256",
        "sourceSessionID",
        "runID",
        "searchRevision",
        "stopReason",
        "candidateID",
        "candidateArtifact",
        "candidateCreatedAt",
        "optimizationResultSHA256",
        "optimizationEvaluationSHA256",
        "selectedAt",
    }
    exact(selection, "selection", fields, fields)
    require(selection["protocolVersion"] == "terminal-verified-best-selection-v1", "invalid selection version")
    stable = dict(selection)
    stable.pop("selectionID")
    require(sha(stable) == selection["selectionID"], "selection content hash is invalid")
    require(selection["protocolSHA256"] == sha(protocol), "selection does not bind this protocol")
    require(valid_hash(selection["candidateArtifact"]["sha256"]), "candidate artifact hash is invalid")

    allowed = {
        "candidateSHA256",
        "manifestSHA256",
        "validatorSHA256",
        "environmentSHA256",
        "outcome",
        "score",
        "metrics",
        "checks",
        "evidence",
        "usage",
        "outputSHA256",
        "evaluatedAt",
    }
    exact(result, "result", allowed, allowed - {"score", "usage"})
    require(
        result["candidateSHA256"] == selection["candidateArtifact"]["sha256"],
        "candidate substitution detected",
    )
    for key in ("manifestSHA256", "validatorSHA256", "environmentSHA256"):
        require(result[key] == protocol["claim"][key], f"frozen {key} changed")
    require(result["outcome"] in {"completed", "failed", "inconclusive"}, "invalid outcome")
    require(isinstance(result["checks"], list) and result["checks"], "checks must be non-empty")
    require(any(item.get("blocking") is True for item in result["checks"]), "a blocking check is required")
    require(isinstance(result["evidence"], list) and result["evidence"], "evidence must be non-empty")
    require(valid_hash(result["outputSHA256"]), "outputSHA256 is invalid")
    require(
        isinstance(result["evaluatedAt"], int) and result["evaluatedAt"] >= selection["selectedAt"],
        "evaluation predates selection",
    )

    metric = protocol["claim"]["metric"]
    completed = result["outcome"] == "completed"
    score = result.get("score")
    require(
        not completed or isinstance(score, (int, float)) and not isinstance(score, bool) and math.isfinite(score),
        "completed result needs a finite score",
    )
    require(completed or score is None, "incomplete result cannot expose a score")
    require(not completed or result["metrics"].get(metric) == score, "bound metric must equal score")
    require(completed or metric not in result["metrics"], "incomplete result cannot expose the bound metric")

    payload = {"schemaVersion": 1, "sessionID": selection["sourceSessionID"], **result}
    Path(args.out).write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    direction = protocol["claim"]["direction"]
    target = protocol["claim"]["target"]
    reached = completed and (score >= target if direction == "maximize" else score <= target)
    print(json.dumps({"valid": True, "tokenFree": True, "derivedTargetReached": reached, "out": args.out}))


if __name__ == "__main__":
    main()
