#!/usr/bin/env python3
import json
import math
import re
import sys
from pathlib import Path


def fail(message: str) -> None:
    raise SystemExit(message)


if len(sys.argv) != 3:
    fail("usage: preflight.py <contract.json> <observations.json>")

contract = json.loads(Path(sys.argv[1]).read_text())
payload = json.loads(Path(sys.argv[2]).read_text())
protocol = contract.get("replication")
if not isinstance(protocol, dict) or protocol.get("protocolVersion") != "replicated-evaluation-v1":
    fail("contract does not contain replicated-evaluation-v1")

sampling = protocol.get("sampling", {})
strata = sampling.get("strata", [])
clusters = sampling.get("clusters", [])
if isinstance(payload, dict) and "evaluatorToken" in payload:
    fail("preflight artifacts must remain token-free; inject the capability only at request time")
if isinstance(payload, dict) and payload.get("sessionID", contract.get("sessionID")) != contract.get("sessionID"):
    fail("submission session does not match the contract")
if isinstance(payload, dict) and payload.get("subject", {}).get("type") == "run":
    if payload["subject"].get("id") != contract.get("runID"):
        fail("run subject does not match the contract")
observations = payload.get("observations", payload) if isinstance(payload, dict) else payload
if not isinstance(observations, list):
    fail("observations must be a JSON array or an object containing observations")

expected = {(item["id"], cluster["id"]) for item in strata for cluster in clusters}
stratum_hashes = {item["id"]: item.get("commitmentSHA256") for item in strata}
cluster_hashes = {item["id"]: item.get("commitmentSHA256") for item in clusters}
actual = [(item.get("stratumID"), item.get("clusterID")) for item in observations]
if len(actual) != len(set(actual)):
    fail("duplicate stratum-cluster observation")
missing = sorted(expected - set(actual))
extra = sorted(set(actual) - expected)
if missing or extra:
    fail(f"frozen grid mismatch: missing={missing} extra={extra}")

estimator = protocol.get("estimator")
environment = protocol.get("environmentSHA256")
if not re.fullmatch(r"[a-f0-9]{64}", str(environment or "")):
    fail("replication protocol requires a frozen environmentSHA256")
if estimator != "pass_rate" and len(clusters) < 5:
    fail("numeric bootstrap requires at least five independent clusters")
if estimator == "pass_rate" and len(clusters) < 3:
    fail("pass-rate evaluation requires at least three independent clusters")
if estimator == "pass_rate" and len(strata) != 1:
    fail("Wilson pass-rate evaluation requires one Bernoulli stratum")
for item in observations:
    status = item.get("status")
    score = item.get("score")
    if status not in {"passed", "failed", "inconclusive"}:
        fail(f"invalid status for {item.get('stratumID')}/{item.get('clusterID')}")
    if estimator == "pass_rate" and score is not None:
        fail("pass_rate observations cannot contain scores")
    if estimator != "pass_rate" and status == "passed" and (
        isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score)
    ):
        fail("passing numeric observations require scores")
    if estimator != "pass_rate" and status != "passed" and score is not None:
        fail("non-passing numeric observations cannot contain scores")
    if not isinstance(item.get("evidence"), list) or not item["evidence"]:
        fail("every observation requires evidence")
    for field in ("stratumSHA256", "clusterSHA256", "outputSHA256", "environmentSHA256"):
        if not re.fullmatch(r"[a-f0-9]{64}", str(item.get(field, ""))):
            fail(f"every observation requires a valid {field}")
    if item.get("stratumSHA256") != stratum_hashes[item.get("stratumID")]:
        fail("observation changed a frozen stratum commitment")
    if item.get("clusterSHA256") != cluster_hashes[item.get("clusterID")]:
        fail("observation changed a frozen cluster commitment")
    if item.get("environmentSHA256") != environment:
        fail("every observation must match the frozen environmentSHA256")
    if isinstance(item.get("evaluatedAt"), bool) or not isinstance(item.get("evaluatedAt"), int) or item["evaluatedAt"] <= 0:
        fail("every observation requires a positive evaluatedAt timestamp")

print(
    json.dumps(
        {
            "valid": True,
            "units": len(observations),
            "strata": len(strata),
            "clusters": len(clusters),
            "estimator": estimator,
            "statuses": {
                status: sum(item.get("status") == status for item in observations)
                for status in ("passed", "failed", "inconclusive")
            },
        },
        sort_keys=True,
    )
)
