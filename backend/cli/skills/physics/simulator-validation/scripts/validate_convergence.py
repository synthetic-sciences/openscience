#!/usr/bin/env python3
"""Validate a simulator refinement study and emit machine-readable checks."""

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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    source = args.input.read_bytes()
    data = json.loads(source)
    require(isinstance(data, dict), "validation input must be an object")
    simulator = data.get("simulator")
    require(isinstance(simulator, dict), "simulator identity is required")
    for field in ("name", "version", "command"):
        require(isinstance(simulator.get(field), str) and simulator[field], f"simulator.{field} is required")
    config_hash = simulator.get("configSHA256")
    require(isinstance(config_hash, str) and len(config_hash) == 64, "simulator.configSHA256 must be 64 hex characters")
    require(all(character in "0123456789abcdef" for character in config_hash), "simulator.configSHA256 must be lowercase hex")

    expected = data.get("expectedOrder")
    tolerance = data.get("orderTolerance")
    maximum = data.get("maxResidual")
    require(isinstance(expected, (int, float)) and not isinstance(expected, bool) and expected > 0, "expectedOrder must be positive")
    require(isinstance(tolerance, (int, float)) and not isinstance(tolerance, bool) and tolerance >= 0, "orderTolerance must be nonnegative")
    require(isinstance(maximum, (int, float)) and not isinstance(maximum, bool) and maximum >= 0, "maxResidual must be nonnegative")
    invariants = data.get("invariantTolerances", {})
    require(isinstance(invariants, dict), "invariantTolerances must be an object")
    require(all(isinstance(key, str) and key for key in invariants), "invariant names must be non-empty strings")
    require(
        all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 for value in invariants.values()),
        "invariant tolerances must be finite and nonnegative",
    )

    levels = data.get("levels")
    require(isinstance(levels, list) and len(levels) >= 3, "at least three refinement levels are required")
    parsed = []
    for index, level in enumerate(levels):
        require(isinstance(level, dict), f"level {index} must be an object")
        label = level.get("label")
        require(isinstance(label, str) and label, f"level {index} needs a label")
        values = {key: level.get(key) for key in ("h", "error", "residual")}
        require(
            all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in values.values()),
            f"level {label} contains a non-finite numeric value",
        )
        require(values["h"] > 0 and values["error"] > 0 and values["residual"] >= 0, f"level {label} has invalid h/error/residual")
        observed = level.get("invariants", {})
        require(isinstance(observed, dict), f"level {label} invariants must be an object")
        require(set(observed) == set(invariants), f"level {label} must report every declared invariant")
        require(
            all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 for value in observed.values()),
            f"level {label} has an invalid invariant deviation",
        )
        parsed.append({"label": label, **values, "invariants": observed})

    resolution = all(left["h"] > right["h"] for left, right in zip(parsed, parsed[1:]))
    monotone = all(left["error"] > right["error"] for left, right in zip(parsed, parsed[1:]))
    orders = [
        math.log(left["error"] / right["error"]) / math.log(left["h"] / right["h"])
        for left, right in zip(parsed, parsed[1:])
    ]
    median = sorted(orders)[len(orders) // 2] if len(orders) % 2 else sum(sorted(orders)[len(orders) // 2 - 1 : len(orders) // 2 + 1]) / 2
    residual = all(level["residual"] <= maximum for level in parsed)
    invariant_status = {
        name: all(level["invariants"][name] <= limit for level in parsed) for name, limit in invariants.items()
    }
    checks = {
        "resolution_decreases": resolution,
        "error_decreases": monotone,
        "observed_order": median >= expected - tolerance,
        "residual_bound": residual,
        **{f"invariant:{name}": status for name, status in invariant_status.items()},
    }
    passed = all(checks.values())
    report = {
        "schemaVersion": 1,
        "passed": passed,
        "inputSHA256": hashlib.sha256(source).hexdigest(),
        "simulator": simulator,
        "observedOrders": orders,
        "medianObservedOrder": median,
        "requiredOrder": expected - tolerance,
        "checks": checks,
        "levels": parsed,
    }
    if args.output:
        write(args.output, report)
    print(json.dumps(report, sort_keys=True))
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        raise SystemExit(2)
