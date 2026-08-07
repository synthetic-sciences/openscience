#!/usr/bin/env python3
"""Validate one-factor benchmark ablations against a frozen baseline."""

import argparse
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def context(run: dict) -> dict:
    return {key: run.get(key) for key in ("seeds", "budget", "split", "evaluator")}


def write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate_run(run: object, label: str) -> dict:
    require(isinstance(run, dict), f"{label} must be an object")
    require(isinstance(run.get("id"), str) and run["id"], f"{label}.id is required")
    require(isinstance(run.get("config"), dict) and run["config"], f"{label}.config is required")
    seeds = run.get("seeds")
    require(isinstance(seeds, list) and seeds, f"{label}.seeds must be non-empty")
    require(all(isinstance(seed, int) and not isinstance(seed, bool) for seed in seeds), f"{label}.seeds must be integers")
    require(len(set(seeds)) == len(seeds), f"{label}.seeds must be unique")
    require(isinstance(run.get("budget"), dict) and run["budget"], f"{label}.budget is required")
    require(isinstance(run.get("split"), str) and run["split"], f"{label}.split is required")
    require(isinstance(run.get("evaluator"), str) and run["evaluator"], f"{label}.evaluator is required")
    return run


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    source = args.input.read_bytes()
    data = json.loads(source)
    require(isinstance(data, dict), "ablation plan must be an object")
    metric = data.get("metric")
    require(isinstance(metric, dict), "metric is required")
    require(isinstance(metric.get("name"), str) and metric["name"], "metric.name is required")
    require(metric.get("direction") in {"maximize", "minimize", "pass"}, "metric.direction is invalid")

    baseline = validate_run(data.get("baseline"), "baseline")
    claims = data.get("claims")
    arms = data.get("arms")
    require(isinstance(claims, list) and claims, "at least one claim is required")
    require(isinstance(arms, list) and arms, "at least one ablation arm is required")
    arms = [validate_run(arm, f"arm[{index}]") for index, arm in enumerate(arms)]
    identifiers = [baseline["id"], *[arm["id"] for arm in arms]]
    require(len(set(identifiers)) == len(identifiers), "baseline and arm ids must be unique")
    claim_ids = [claim.get("id") for claim in claims if isinstance(claim, dict)]
    require(len(claim_ids) == len(claims) and all(isinstance(value, str) and value for value in claim_ids), "claim ids are required")
    require(len(set(claim_ids)) == len(claim_ids), "claim ids must be unique")

    contrasts = []
    for index, claim in enumerate(claims):
        require(isinstance(claim, dict), f"claim[{index}] must be an object")
        factor = claim.get("factor")
        require(isinstance(factor, str) and factor, f"claim {claim['id']} needs a factor")
        require("from" in claim and "to" in claim, f"claim {claim['id']} needs explicit from and to values")
        require(factor in baseline["config"], f"claim {claim['id']} factor is absent from the baseline")
        require(baseline["config"][factor] == claim.get("from"), f"claim {claim['id']} baseline value does not match from")
        matches = []
        for arm in arms:
            keys = set(baseline["config"]) | set(arm["config"])
            changes = sorted(key for key in keys if baseline["config"].get(key) != arm["config"].get(key))
            if arm.get("interactionFactors") is not None:
                interaction = arm["interactionFactors"]
                require(isinstance(interaction, list) and len(interaction) >= 2, f"arm {arm['id']} interactionFactors is invalid")
                require(sorted(interaction) == changes, f"arm {arm['id']} interactionFactors do not match its changes")
            else:
                require(len(changes) == 1, f"arm {arm['id']} changes {len(changes)} factors without an interaction declaration")
            require(context(arm) == context(baseline), f"arm {arm['id']} drifts seed, budget, split, or evaluator")
            if changes == [factor] and arm["config"].get(factor) == claim.get("to"):
                matches.append(arm["id"])
        require(len(matches) == 1, f"claim {claim['id']} needs exactly one matching isolation arm")
        contrasts.append({"claim": claim["id"], "baseline": baseline["id"], "arm": matches[0], "factor": factor})

    report = {
        "schemaVersion": 1,
        "passed": True,
        "inputSHA256": hashlib.sha256(source).hexdigest(),
        "metric": metric,
        "baseline": baseline["id"],
        "contrasts": contrasts,
        "seeds": baseline["seeds"],
        "budget": baseline["budget"],
    }
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
