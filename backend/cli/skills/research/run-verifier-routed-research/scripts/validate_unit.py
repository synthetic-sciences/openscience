#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path


def fail(message: str) -> None:
    raise SystemExit(f"invalid verifier-loop unit: {message}")


if len(sys.argv) != 2:
    fail("usage: validate_unit.py <work.json>")

data = json.loads(Path(sys.argv[1]).read_text())
if not isinstance(data, dict):
    fail("root must be an object")
if not re.fullmatch(r"[a-f0-9]{64}", str(data.get("id", ""))):
    fail("id must be a sha256 digest")
if data.get("status") != "pending":
    fail("work must be pending")

role = data.get("role")
if role not in {"generation", "revision", "verification", "investigation"}:
    fail("unsupported role")
label = data.get("label")
if not isinstance(label, str) or not label:
    fail("label is required")
prompt = data.get("prompt")
if not isinstance(prompt, str) or f'role="{role}" topology="verifier_loop"' not in prompt:
    fail("prompt is not bound to the declared verifier-loop role")

context = data.get("context")
if not isinstance(context, list) or any(not isinstance(item, dict) for item in context):
    fail("context must be an array of work results")
roles = [item.get("role") for item in context]
candidate = any(item in {"generation", "revision"} for item in roles)
reviews = sum(item == "verification" for item in roles)

if role == "generation" and label == "initial-candidate" and context:
    fail("initial candidate must not receive ancestor context")
if role == "generation" and label.startswith("clean-restart-") and (not context or reviews != len(context)):
    fail("clean restart may receive verifier summaries only")
if role == "revision" and (not candidate or reviews < 1):
    fail("targeted revision needs the candidate and rejecting panel")
if role == "investigation" and (not candidate or reviews < 1):
    fail("investigation needs the candidate and inconclusive panel")
if role == "verification" and (not candidate or reviews):
    fail("verification needs a candidate and cannot receive another verifier verdict")

allocation = data.get("allocation")
if not isinstance(allocation, dict) or not allocation:
    fail("allocation is required")
if any(not isinstance(value, (int, float)) or value < 0 for value in allocation.values()):
    fail("allocation values must be nonnegative numbers")

requirements = {
    "generation": "return one complete candidate artifact",
    "revision": "return one complete replacement artifact",
    "investigation": "return evidence without editing the candidate",
    "verification": "return an evidence-backed decision, severity, confidence, and checks",
}
print(json.dumps({"valid": True, "role": role, "label": label, "requirement": requirements[role]}))
