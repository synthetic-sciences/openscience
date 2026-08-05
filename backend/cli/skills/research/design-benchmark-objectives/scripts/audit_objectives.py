#!/usr/bin/env python3
"""Audit benchmark optimization objectives before they enter candidate search."""

import argparse
import hashlib
import json
import math
import os
import sys
import tempfile
from pathlib import Path


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def strict(value: object, label: str, required: set[str], optional: set[str] | None = None) -> dict:
    require(isinstance(value, dict), f"{label} must be an object")
    allowed = required | (optional or set())
    missing = sorted(required - set(value))
    unknown = sorted(set(value) - allowed)
    require(not missing, f"{label} is missing {', '.join(missing)}")
    require(not unknown, f"{label} has unknown fields {', '.join(unknown)}")
    return value


def text(value: object, label: str) -> str:
    require(isinstance(value, str) and bool(value.strip()), f"{label} must be a non-empty string")
    return value


def sha(value: object, label: str) -> str:
    result = text(value, label)
    require(len(result) == 64 and all(char in "0123456789abcdef" for char in result), f"{label} must be lowercase SHA-256")
    return result


def number(value: object, label: str) -> float | int:
    require(isinstance(value, (int, float)) and not isinstance(value, bool), f"{label} must be numeric")
    require(math.isfinite(value), f"{label} must be finite")
    return value


def strings(value: object, label: str, unique: bool = True) -> list[str]:
    require(isinstance(value, list) and bool(value), f"{label} must be a non-empty array")
    result = [text(item, f"{label}[{index}]") for index, item in enumerate(value)]
    if unique:
        require(len(set(result)) == len(result), f"{label} must be unique")
    return result


def anchors(value: object, direction: str, label: str) -> dict:
    result = strict(value, label, {"poor", "good"})
    poor = number(result["poor"], f"{label}.poor")
    good = number(result["good"], f"{label}.good")
    require(poor != good, f"{label} must distinguish poor and good values")
    if direction == "maximize":
        require(good > poor, f"{label}.good must be greater than poor for maximize")
    if direction == "minimize":
        require(good < poor, f"{label}.good must be less than poor for minimize")
    return {"poor": poor, "good": good}


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def unique(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON field {key}")
        result[key] = value
    return result


def write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True, allow_nan=False)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate(data: object, source: bytes) -> dict:
    plan = strict(data, "plan", {"schemaVersion", "benchmark", "primary", "objectives", "signals", "guards", "policy"})
    require(plan["schemaVersion"] == 1, "schemaVersion must be 1")

    benchmark = strict(plan["benchmark"], "benchmark", {"id", "optimizationSplit", "claimSplit", "evaluator"})
    text(benchmark["id"], "benchmark.id")
    optimization = text(benchmark["optimizationSplit"], "benchmark.optimizationSplit")
    claim = text(benchmark["claimSplit"], "benchmark.claimSplit")
    require(optimization != claim, "optimizationSplit and claimSplit must be distinct")
    evaluator = strict(benchmark["evaluator"], "benchmark.evaluator", {"name", "version", "sha256", "owner"})
    text(evaluator["name"], "benchmark.evaluator.name")
    text(evaluator["version"], "benchmark.evaluator.version")
    sha(evaluator["sha256"], "benchmark.evaluator.sha256")
    require(evaluator["owner"] == "evaluator", "benchmark evaluator must be evaluator-owned")

    primary = strict(plan["primary"], "primary", {"metric", "direction", "unit", "official", "anchors"})
    metric = text(primary["metric"], "primary.metric")
    require(primary["direction"] in {"maximize", "minimize"}, "primary.direction must be maximize or minimize")
    text(primary["unit"], "primary.unit")
    require(primary["official"] is True, "primary metric must remain official")
    anchors(primary["anchors"], primary["direction"], "primary.anchors")

    raw_signals = plan["signals"]
    require(isinstance(raw_signals, list) and bool(raw_signals), "signals must be a non-empty array")
    signals = {}
    for index, raw in enumerate(raw_signals):
        signal = strict(raw, f"signals[{index}]", {"id", "owner", "scope", "candidateReadable", "valueRelease", "sourceSHA256"})
        identifier = text(signal["id"], f"signals[{index}].id")
        require(identifier not in signals, "signal ids must be unique")
        require(signal["owner"] == "evaluator", f"signal {identifier} must be evaluator-owned")
        require(signal["scope"] in {"optimization", "runtime", "claim"}, f"signal {identifier} has invalid scope")
        require(signal["candidateReadable"] is False, f"signal {identifier} cannot be candidate-readable")
        require(signal["valueRelease"] in {"after_final", "never"}, f"signal {identifier} values must be delayed")
        sha(signal["sourceSHA256"], f"signal {identifier}.sourceSHA256")
        signals[identifier] = signal

    raw_guards = plan["guards"]
    require(isinstance(raw_guards, list) and bool(raw_guards), "guards must be a non-empty array")
    guards = {}
    shells = {"bash", "cmd", "cmd.exe", "powershell", "pwsh", "sh", "zsh"}
    for index, raw in enumerate(raw_guards):
        guard = strict(raw, f"guards[{index}]", {"id", "kind", "argv", "blocking", "scope", "sourceSHA256", "protects"})
        identifier = text(guard["id"], f"guards[{index}].id")
        require(identifier not in guards, "guard ids must be unique")
        require(guard["kind"] in {"heldout", "invariant", "resource", "adversarial", "regression"}, f"guard {identifier} has invalid kind")
        argv = strings(guard["argv"], f"guard {identifier}.argv", False)
        require(Path(argv[0]).name.lower() not in shells, f"guard {identifier} must use argv without a shell")
        require(guard["blocking"] is True, f"guard {identifier} must be blocking")
        require(guard["scope"] in {"optimization", "runtime"}, f"guard {identifier} cannot use claim-split data during search")
        sha(guard["sourceSHA256"], f"guard {identifier}.sourceSHA256")
        strings(guard["protects"], f"guard {identifier}.protects")
        guards[identifier] = guard

    raw_objectives = plan["objectives"]
    require(isinstance(raw_objectives, list) and 1 <= len(raw_objectives) <= 8, "objectives must contain between one and eight items")
    objectives = []
    details = []
    used_signals = set()
    used_guards = set()
    for index, raw in enumerate(raw_objectives):
        objective = strict(raw, f"objectives[{index}]", {"metric", "direction", "role", "unit", "signal", "anchors", "risks", "guardIDs"})
        name = text(objective["metric"], f"objectives[{index}].metric")
        require(name != metric, f"secondary objective {name} cannot duplicate primary metric")
        require(name not in {item["metric"] for item in objectives}, "secondary objective metrics must be unique")
        require(objective["direction"] in {"maximize", "minimize"}, f"objective {name} has invalid direction")
        require(objective["role"] in {"diversity", "constraint"}, f"objective {name} has invalid role")
        text(objective["unit"], f"objective {name}.unit")
        anchors(objective["anchors"], objective["direction"], f"objective {name}.anchors")
        strings(objective["risks"], f"objective {name}.risks")
        signal_id = text(objective["signal"], f"objective {name}.signal")
        require(signal_id in signals, f"objective {name} references unknown signal {signal_id}")
        require(signals[signal_id]["scope"] != "claim", f"objective {name} cannot use claim-only signal {signal_id}")
        guard_ids = strings(objective["guardIDs"], f"objective {name}.guardIDs")
        require(all(identifier in guards for identifier in guard_ids), f"objective {name} references an unknown guard")
        require(all(name in guards[identifier]["protects"] for identifier in guard_ids), f"objective {name} is not protected by every referenced guard")
        require(any(guards[identifier]["kind"] != "resource" for identifier in guard_ids), f"objective {name} needs a non-resource anti-gaming guard")
        used_signals.add(signal_id)
        used_guards.update(guard_ids)
        objectives.append({"metric": name, "direction": objective["direction"]})
        details.append(objective)

    require(used_signals == set(signals), "signals must be referenced exactly by declared objectives")
    require(used_guards == set(guards), "guards must be referenced by declared objectives")
    objective_names = {item["metric"] for item in objectives}
    require(all(set(guard["protects"]).issubset(objective_names) for guard in guards.values()), "guards may protect only declared objectives")

    policy = strict(
        plan["policy"],
        "policy",
        {"winnerMetric", "targetMetric", "archive", "promotion", "missingObjective", "valueRelease", "claimSplitUsage", "candidateCanReadObjectiveValues"},
    )
    require(policy["winnerMetric"] == metric, f"policy.winnerMetric must equal primary metric {metric}")
    require(policy["targetMetric"] == metric, f"policy.targetMetric must equal primary metric {metric}")
    require(policy["archive"] == "pareto", "policy.archive must be pareto")
    require(policy["promotion"] == "final_only", "policy.promotion must be final_only")
    require(policy["missingObjective"] == "reject", "policy.missingObjective must be reject")
    require(policy["valueRelease"] == "after_final", "policy.valueRelease must be after_final")
    require(policy["claimSplitUsage"] == "post_search_only", "policy.claimSplitUsage must be post_search_only")
    require(policy["candidateCanReadObjectiveValues"] is False, "candidates cannot read objective values during search")

    patch = {
        "profile": "optimize",
        "metric": {"name": metric, "direction": primary["direction"]},
        "objectives": objectives,
    }
    contract = {
        "benchmark": benchmark,
        "primary": primary,
        "objectives": details,
        "signals": [signals[identifier] for identifier in sorted(signals)],
        "guards": [guards[identifier] for identifier in sorted(guards)],
        "adapterPatch": patch,
        "policy": policy,
    }
    plan_sha = hashlib.sha256(canonical(plan)).hexdigest()
    validator_sha = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    contract_sha = hashlib.sha256(canonical(contract)).hexdigest()
    audit = {
        "schemaVersion": 1,
        "planSHA256": plan_sha,
        "validatorSHA256": validator_sha,
        "contractSHA256": contract_sha,
        "guardIDs": sorted(guards),
    }
    return {
        "schemaVersion": 1,
        "status": "passed",
        "inputSHA256": hashlib.sha256(source).hexdigest(),
        "planSHA256": plan_sha,
        "validatorSHA256": validator_sha,
        "contractSHA256": contract_sha,
        "contract": contract,
        "adapterPatch": {**patch, "objectiveAudit": audit},
        "checks": [
            "evaluator_authority",
            "split_separation",
            "numeric_directions",
            "objective_uniqueness",
            "evaluator_owned_signals",
            "proxy_guards",
            "primary_score_authority",
            "final_only_complete_vectors",
            "delayed_value_boundary",
        ],
        "signals": len(signals),
        "guards": len(guards),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["audit", "commitments"])
    parser.add_argument("input", nargs="?", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.command == "commitments":
        require(args.input is None, "commitments does not accept an input")
        print(json.dumps({"name": "design-benchmark-objectives", "schemaVersion": 1, "validatorSHA256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}, sort_keys=True))
        return 0
    require(args.input is not None, "audit requires an input plan")
    source = args.input.read_bytes()
    report = validate(json.loads(source, object_pairs_hook=unique), source)
    if args.output:
        write(args.output, report)
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        raise SystemExit(2)
