#!/usr/bin/env python3
"""Build an OpenScience runtime-integrity submission from evaluator-owned evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any


HASH = set("0123456789abcdef")
KINDS = {
    "command",
    "tool_call",
    "network",
    "model_call",
    "benchmark_lookup",
    "hidden_canary",
    "artifact_write",
    "trace_gap",
}
AUDITS = {"test_item_contamination", "external_model_use", "benchmark_lookup"}
ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "references" / "trace-schema.json"


class Invalid(ValueError):
    pass


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


def integer(value: Any, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise Invalid(f"{label} must be an integer >= {minimum}")
    return value


def boolean(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise Invalid(f"{label} must be a boolean")
    return value


def digest(value: Any, label: str) -> str:
    if not is_hash(value):
        raise Invalid(f"{label} must be a lowercase SHA-256")
    return value


def load(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise Invalid(f"cannot read {label} {path}: {exc}") from exc


def artifact(value: Any, label: str) -> dict[str, str]:
    item = obj(value, label)
    return {"uri": text(item.get("uri"), f"{label}.uri"), "sha256": digest(item.get("sha256"), f"{label}.sha256")}


def contract(path: Path) -> dict[str, Any]:
    value = obj(load(path, "contract"), "contract")
    if value.get("protocolVersion") != "benchmark-integrity-v1":
        raise Invalid("contract.protocolVersion must be benchmark-integrity-v1")
    if digest(value.get("validatorSHA256"), "contract.validatorSHA256") != sha(Path(__file__).resolve()):
        raise Invalid("contract validatorSHA256 does not match this exact script")
    if digest(value.get("traceSchemaSHA256"), "contract.traceSchemaSHA256") != sha(SCHEMA):
        raise Invalid("contract traceSchemaSHA256 does not match the bundled trace schema")
    integer(value.get("minEvents"), "contract.minEvents", 1)
    coverage = value.get("minCoverage")
    if isinstance(coverage, bool) or not isinstance(coverage, (int, float)) or not 0.9 <= coverage <= 1:
        raise Invalid("contract.minCoverage must be between 0.9 and 1")
    assigned = obj(value.get("assignedModel"), "contract.assignedModel")
    text(assigned.get("name"), "contract.assignedModel.name")
    digest(assigned.get("baseArtifactSHA256"), "contract.assignedModel.baseArtifactSHA256")
    digest(assigned.get("configSHA256"), "contract.assignedModel.configSHA256")
    forbidden = value.get("forbiddenModelArtifacts", [])
    if not isinstance(forbidden, list) or any(not is_hash(item) for item in forbidden) or len(set(forbidden)) != len(forbidden):
        raise Invalid("contract.forbiddenModelArtifacts must contain unique lowercase SHA-256 values")
    policy = obj(value.get("policy"), "contract.policy")
    expected_policy = {
        "testItemDerivation": "forbidden",
        "unapprovedExternalModels": "forbidden",
        "benchmarkLookup": "forbidden",
    }
    if policy != expected_policy:
        raise Invalid("contract.policy must use the strict benchmark-integrity-v1 policy")
    auditors = value.get("auditors")
    if not isinstance(auditors, list) or len(auditors) != len(AUDITS):
        raise Invalid("contract.auditors must contain exactly three entries")
    if {obj(item, "contract auditor").get("kind") for item in auditors} != AUDITS:
        raise Invalid("contract.auditors must cover every integrity audit kind")
    for item in auditors:
        auditor = obj(item, "contract auditor")
        text(auditor.get("name"), "contract auditor name")
        text(auditor.get("version"), "contract auditor version")
        digest(auditor.get("promptSHA256"), "contract auditor promptSHA256")
    digest(value.get("hiddenCanaryManifestSHA256"), "contract.hiddenCanaryManifestSHA256")
    integer(value.get("minHiddenCanaries"), "contract.minHiddenCanaries", 1)
    return value


def trace(path: Path, schema: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    events: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise Invalid(f"cannot read trace {path}: {exc}") from exc
    if not lines:
        raise Invalid("trace must contain at least one event")
    prior = 0
    for index, line in enumerate(lines):
        if not line.strip():
            raise Invalid(f"trace line {index + 1} is blank")
        try:
            event = obj(json.loads(line), f"trace line {index + 1}")
        except json.JSONDecodeError as exc:
            raise Invalid(f"trace line {index + 1} is not valid JSON: {exc}") from exc
        if integer(event.get("seq"), f"trace line {index + 1}.seq") != index:
            raise Invalid(f"trace sequence must be contiguous from zero; line {index + 1} is not seq {index}")
        at = integer(event.get("at"), f"trace line {index + 1}.at", 1)
        if index and at < prior:
            raise Invalid(f"trace timestamp reverses at line {index + 1}")
        prior = at
        kind = event.get("kind")
        if kind not in KINDS:
            raise Invalid(f"trace line {index + 1}.kind is unsupported")
        if kind == "model_call":
            boolean(event.get("approved"), f"trace line {index + 1}.approved")
        if kind == "hidden_canary":
            digest(event.get("manifestSHA256"), f"trace line {index + 1}.manifestSHA256")
            text(event.get("canaryID"), f"trace line {index + 1}.canaryID")
            boolean(event.get("violation"), f"trace line {index + 1}.violation")
        if kind == "trace_gap":
            integer(event.get("dropped"), f"trace line {index + 1}.dropped", 1)
        events.append(event)
    canaries = [event for event in events if event["kind"] == "hidden_canary"]
    ids = [event["canaryID"] for event in canaries]
    if len(ids) != len(set(ids)):
        raise Invalid("hidden canary IDs must be unique")
    manifests = {event["manifestSHA256"] for event in canaries}
    if len(manifests) > 1:
        raise Invalid("trace mixes hidden canary manifests")
    dropped = sum(event["dropped"] for event in events if event["kind"] == "trace_gap")
    activity = {
        "unapprovedExternalModelCalls": sum(
            1 for event in events if event["kind"] == "model_call" and not event["approved"]
        ),
        "benchmarkLookupEvents": sum(1 for event in events if event["kind"] == "benchmark_lookup"),
        "hiddenCanaryManifestSHA256": next(iter(manifests), schema),
        "hiddenCanariesTested": len(canaries),
        "hiddenCanaryViolations": sum(1 for event in canaries if event["violation"]),
    }
    return events, {"dropped": dropped, "activity": activity}


def model(path: Path) -> dict[str, Any]:
    value = obj(load(path, "model"), "model")
    return {
        "name": text(value.get("name"), "model.name"),
        "baseArtifactSHA256": digest(value.get("baseArtifactSHA256"), "model.baseArtifactSHA256"),
        "configSHA256": digest(value.get("configSHA256"), "model.configSHA256"),
        "outputArtifactSHA256": digest(value.get("outputArtifactSHA256"), "model.outputArtifactSHA256"),
        "lineageVerified": boolean(value.get("lineageVerified"), "model.lineageVerified"),
    }


def audits(path: Path, protocol: dict[str, Any]) -> list[dict[str, Any]]:
    value = load(path, "audits")
    if not isinstance(value, list) or len(value) != len(AUDITS):
        raise Invalid("audits must contain exactly three entries")
    expected = {item["kind"]: item for item in protocol["auditors"]}
    output = []
    for raw in value:
        item = obj(raw, "audit")
        kind = item.get("kind")
        if kind not in AUDITS or kind in {entry["kind"] for entry in output}:
            raise Invalid("audits must contain each integrity audit kind exactly once")
        identity = {key: item.get(key) for key in ("kind", "name", "version", "promptSHA256")}
        if identity != expected[kind]:
            raise Invalid(f"{kind} auditor identity does not match the contract")
        decision = item.get("decision")
        if decision not in {"clean", "flagged", "abstain"}:
            raise Invalid(f"{kind} decision must be clean, flagged, or abstain")
        confidence = item.get("confidence")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            raise Invalid(f"{kind} confidence must be between zero and one")
        evidence = item.get("evidence")
        if not isinstance(evidence, list) or not evidence or any(not isinstance(ref, str) or not ref for ref in evidence):
            raise Invalid(f"{kind} evidence must be a non-empty string list")
        output.append({**identity, "decision": decision, "confidence": confidence, "evidence": sorted(evidence)})
    return sorted(output, key=lambda item: item["kind"])


def build(args: argparse.Namespace) -> dict[str, Any]:
    protocol = contract(args.contract)
    subject = obj(load(args.subject, "subject"), "subject")
    if subject.get("type") not in {"run", "candidate"}:
        raise Invalid("subject.type must be run or candidate")
    subject = {
        "type": subject["type"],
        "id": text(subject.get("id"), "subject.id"),
        "artifact": artifact(subject.get("artifact"), "subject.artifact"),
    }
    events, observed = trace(args.trace, protocol["hiddenCanaryManifestSHA256"])
    activity = observed["activity"]
    if activity["hiddenCanaryManifestSHA256"] != protocol["hiddenCanaryManifestSHA256"]:
        raise Invalid("trace hidden canary manifest does not match the contract")
    at = args.evaluated_at or int(time.time() * 1000)
    submission = {
        "schemaVersion": 1,
        "runID": args.run_id,
        "sessionID": args.session_id,
        "protocol": protocol,
        "subject": subject,
        "trace": {
            "artifact": {"uri": args.trace_uri or str(args.trace.resolve()), "sha256": sha(args.trace)},
            "schemaSHA256": protocol["traceSchemaSHA256"],
            "events": len(events),
            "dropped": observed["dropped"],
            "startedAt": events[0]["at"],
            "endedAt": events[-1]["at"],
        },
        "model": model(args.model),
        "audits": audits(args.audits, protocol),
        "activity": activity,
        "validator": {
            "name": "verify-benchmark-integrity",
            "version": 1,
            "scriptSHA256": sha(Path(__file__).resolve()),
        },
        "evidence": sorted(set(args.evidence or [f"artifact:{args.trace.name}"])),
        "evaluatedAt": at,
    }
    if submission["trace"]["endedAt"] > at:
        raise Invalid("evaluatedAt cannot predate the trace end")
    return submission


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("commitments", help="print exact script and trace-schema SHA-256 commitments")
    check = commands.add_parser("check-trace", help="validate normalized trace structure before full receipt assembly")
    check.add_argument("--trace", type=Path, required=True)
    check.add_argument("--canary-manifest", required=True)
    command = commands.add_parser("build", help="build a token-free runtime-integrity submission")
    command.add_argument("--contract", type=Path, required=True)
    command.add_argument("--trace", type=Path, required=True)
    command.add_argument("--trace-uri")
    command.add_argument("--subject", type=Path, required=True)
    command.add_argument("--model", type=Path, required=True)
    command.add_argument("--audits", type=Path, required=True)
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
            output = {"validatorSHA256": sha(Path(__file__).resolve()), "traceSchemaSHA256": sha(SCHEMA)}
            print(json.dumps(output, sort_keys=True))
            return 0
        if args.command == "check-trace":
            manifest = digest(args.canary_manifest, "canary manifest")
            events, observed = trace(args.trace, manifest)
            print(json.dumps({"events": len(events), **observed}, sort_keys=True))
            return 0
        submission = build(args)
        rendered = json.dumps(submission, indent=2, sort_keys=True) + "\n"
        if args.output:
            args.output.write_text(rendered, encoding="utf-8")
        else:
            sys.stdout.write(rendered)
        if args.report:
            coverage = submission["trace"]["events"] / (
                submission["trace"]["events"] + submission["trace"]["dropped"]
            )
            report = {
                "schemaVersion": 1,
                "submissionSHA256": hashlib.sha256(rendered.encode()).hexdigest(),
                "traceCoverage": coverage,
                "observableViolations": {
                    "unapprovedExternalModelCalls": submission["activity"]["unapprovedExternalModelCalls"],
                    "benchmarkLookupEvents": submission["activity"]["benchmarkLookupEvents"],
                    "hiddenCanaryViolations": submission["activity"]["hiddenCanaryViolations"],
                },
                "auditorDecisions": {item["kind"]: item["decision"] for item in submission["audits"]},
                "note": "Preview only; the OpenScience backend derives the authoritative receipt outcome.",
            }
            args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return 0
    except (Invalid, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
