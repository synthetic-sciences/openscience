#!/usr/bin/env python3
import hashlib
import json
import re
import sys
from pathlib import Path


def fail(message: str) -> None:
    raise SystemExit(f"invalid adaptive lease: {message}")


if len(sys.argv) != 2:
    raise SystemExit("usage: validate_lease.py <lease.json>")

path = Path(sys.argv[1])
raw = sys.stdin.buffer.read() if sys.argv[1] == "-" else path.read_bytes()
value = json.loads(raw)
required = {
    "id",
    "revision",
    "strategy",
    "mode",
    "parentIDs",
    "inspirationIDs",
    "targetIsland",
    "contextIDs",
    "reasons",
    "control",
}
missing = required - value.keys()
if missing:
    fail(f"missing fields: {', '.join(sorted(missing))}")
if not re.fullmatch(r"[a-f0-9]{64}", value["id"]):
    fail("id must be a lowercase sha256")
if value["strategy"] not in {"seed", "explore", "exploit", "fuse", "migrate", "diverge"}:
    fail("unknown strategy")
if value["mode"] not in {"single-pass", "stepwise", "diff"}:
    fail("unknown generation mode")
if not isinstance(value["revision"], int) or value["revision"] < 0:
    fail("revision must be a nonnegative integer")
if not isinstance(value["targetIsland"], int) or value["targetIsland"] < 0:
    fail("targetIsland must be a nonnegative integer")
for field, limit in (("parentIDs", 2), ("inspirationIDs", 2), ("contextIDs", 6)):
    items = value[field]
    if not isinstance(items, list) or len(items) > limit or len(items) != len(set(items)):
        fail(f"{field} must be a unique list of at most {limit} ids")
    if any(not isinstance(item, str) or not re.fullmatch(r"[a-f0-9]{64}", item) for item in items):
        fail(f"{field} contains a non-sha256 id")
if set(value["parentIDs"]) & set(value["inspirationIDs"]):
    fail("parents and inspirations must be distinct")

control = value["control"]
fields = {
    "protocolVersion",
    "policySHA256",
    "eventCount",
    "stalled",
    "targetIsland",
    "visits",
    "accumulatedImprovement",
    "rewardMean",
    "intensity",
    "draw",
    "explore",
    "globalStagnation",
}
if not isinstance(control, dict) or fields - control.keys():
    fail("controller snapshot is incomplete")
if control["protocolVersion"] != "adaptive-search-v1":
    fail("unsupported controller protocol")
if not re.fullmatch(r"[a-f0-9]{64}", control["policySHA256"]):
    fail("policySHA256 must be a lowercase sha256")
if control["targetIsland"] != value["targetIsland"]:
    fail("controller and lease target islands differ")
for field in ("eventCount", "stalled", "visits"):
    if not isinstance(control[field], int) or control[field] < 0:
        fail(f"{field} must be a nonnegative integer")
for field in ("accumulatedImprovement", "rewardMean"):
    if not isinstance(control[field], (int, float)) or control[field] < 0:
        fail(f"{field} must be nonnegative")
for field in ("intensity", "draw"):
    if not isinstance(control[field], (int, float)) or not 0 <= control[field] <= 1:
        fail(f"{field} must be in [0, 1]")
if control["explore"] != (control["draw"] < control["intensity"]):
    fail("explore does not match the deterministic intensity draw")
if value["strategy"] == "seed" and value["parentIDs"]:
    fail("seed cannot have parents")
if value["strategy"] in {"exploit", "diverge"} and len(value["parentIDs"]) != 1:
    fail(f"{value['strategy']} requires one parent")
if value["strategy"] == "fuse" and len(value["parentIDs"]) != 2:
    fail("fuse requires two parents")
if value["strategy"] == "migrate" and (len(value["parentIDs"]) != 1 or len(value["inspirationIDs"]) != 1):
    fail("migrate requires one parent and one inspiration")

summary = {
    "valid": True,
    "leaseSHA256": hashlib.sha256(raw).hexdigest(),
    "strategy": value["strategy"],
    "mode": value["mode"],
    "targetIsland": value["targetIsland"],
    "eventCount": control["eventCount"],
    "explore": control["explore"],
    "globalStagnation": control["globalStagnation"],
}
print(json.dumps(summary, sort_keys=True))
