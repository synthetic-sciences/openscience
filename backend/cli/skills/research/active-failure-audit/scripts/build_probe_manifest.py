#!/usr/bin/env python3
"""Build a public active-audit manifest without copying hidden probe content."""

import argparse
import hashlib
import json
import math
import os
import sys
import tempfile
from pathlib import Path


def fail(message: str) -> None:
    raise ValueError(message)


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if args.output.exists() and not args.force:
        fail(f"output already exists: {args.output}")

    rows = []
    for number, line in enumerate(args.input.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError as error:
            fail(f"line {number} is not valid JSON: {error.msg}")
        if not isinstance(item, dict):
            fail(f"line {number} must be an object")
        if "hidden" not in item:
            fail(f"line {number} is missing hidden content")
        identifier = item.get("id")
        features = item.get("features")
        stratum = item.get("stratum")
        if not isinstance(identifier, str) or not identifier or len(identifier) > 240:
            fail(f"line {number} has an invalid id")
        if not isinstance(stratum, str) or not stratum or len(stratum) > 120:
            fail(f"line {number} has an invalid stratum")
        if not isinstance(features, list) or not 1 <= len(features) <= 32:
            fail(f"line {number} must contain 1 to 32 features")
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in features):
            fail(f"line {number} contains a non-finite numeric feature")
        weight = item.get("weight", 1)
        prior = item.get("priorLoss", 0.5)
        if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not 0 < weight <= 1000:
            fail(f"line {number} has an invalid weight")
        if isinstance(prior, bool) or not isinstance(prior, (int, float)) or not 0 <= prior <= 1:
            fail(f"line {number} has an invalid priorLoss")
        rows.append(
            {
                "id": identifier,
                "commitment": hashlib.sha256(canonical(item["hidden"])).hexdigest(),
                "features": features,
                "stratum": stratum,
                "weight": weight,
                "priorLoss": prior,
            }
        )

    if len(rows) < 2:
        fail("at least two non-empty probes are required")
    if len({row["id"] for row in rows}) != len(rows):
        fail("probe ids must be unique")
    if len({row["commitment"] for row in rows}) != len(rows):
        fail("hidden probe commitments must be unique")
    if len({len(row["features"]) for row in rows}) != 1:
        fail("all probes must share one feature dimension")

    probes = sorted(rows, key=lambda row: row["id"])
    payload = {
        "schemaVersion": 1,
        "manifestSHA256": hashlib.sha256(canonical(probes)).hexdigest(),
        "probes": probes,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{args.output.name}.", dir=args.output.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        os.replace(temporary, args.output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(json.dumps({"probes": len(probes), "manifestSHA256": payload["manifestSHA256"]}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        raise SystemExit(2)
