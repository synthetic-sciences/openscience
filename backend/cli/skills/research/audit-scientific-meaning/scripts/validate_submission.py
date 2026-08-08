#!/usr/bin/env python3
import hashlib
import json
import math
import sys
from pathlib import Path


def fail(message: str) -> None:
    raise SystemExit(f"invalid semantic audit submission: {message}")


if len(sys.argv) != 3:
    fail("usage: validate_submission.py <contract.json> <submission.json>")

contract = json.loads(Path(sys.argv[1]).read_text())
submission = json.loads(Path(sys.argv[2]).read_text())
if not isinstance(contract, dict) or not isinstance(submission, dict):
    fail("contract and submission must be objects")
if "reviewerToken" in submission or any("token" in key.lower() for key in submission):
    fail("submission must remain token-free on disk")

protocol = contract.get("semanticAudit")
if not isinstance(protocol, dict) or protocol.get("protocolVersion") != "semantic-audit-v1":
    fail("contract does not contain semantic-audit-v1")
scope = protocol.get("scope")
if not isinstance(scope, dict):
    fail("semantic scope is required")
objective = contract.get("objective")
if not isinstance(objective, str) or hashlib.sha256(objective.encode()).hexdigest() != scope.get("objectiveSHA256"):
    fail("objective commitment does not match the contract objective")
if submission.get("sessionID") != contract.get("sessionID"):
    fail("submission session does not match the contract")
subject = submission.get("subject")
if not isinstance(subject, dict) or subject.get("type") not in {"run", "candidate"} or not subject.get("id"):
    fail("subject must identify one run or candidate")
if subject.get("type") == "run" and subject.get("id") != contract.get("runID"):
    fail("run subject does not match the contract")

reviews = submission.get("reviews")
minimum = protocol.get("minReviewers")
if not isinstance(reviews, list) or not isinstance(minimum, int) or len(reviews) < minimum or len(reviews) > 5:
    fail("review panel does not meet the frozen size")
actors = [item.get("actor") for item in reviews if isinstance(item, dict)]
sessions = [item.get("sessionID") for item in reviews if isinstance(item, dict)]
if len(actors) != len(reviews) or len(set(actors)) != len(reviews) or not all(actors):
    fail("reviewers must use distinct non-empty actors")
if len(sessions) != len(reviews) or len(set(sessions)) != len(reviews) or not all(sessions):
    fail("reviewers must use distinct non-empty sessions")

criterion_ids = sorted(item.get("id") for item in scope.get("criteria", []) if isinstance(item, dict))
shortcut_ids = sorted(item.get("id") for item in scope.get("forbiddenShortcuts", []) if isinstance(item, dict))
levels = {"not_required": -1, "known": 0, "rediscovery": 1, "minor": 2, "publication": 3, "major": 4}
floor = scope.get("noveltyFloor")
if not criterion_ids or not shortcut_ids or floor not in levels:
    fail("contract semantic scope is incomplete")
threshold = protocol.get("minConfidence")
if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not math.isfinite(threshold):
    fail("contract minimum confidence is invalid")

incorrect = []
uncertain = []
technical = []
for review in reviews:
    if not isinstance(review, dict):
        fail("every review must be an object")
    if review.get("correctness") not in {"passed", "failed", "inconclusive"}:
        fail("review correctness is invalid")
    if review.get("alignment") not in {"intended", "reasonable_alternative", "misinterpreted", "ambiguous"}:
        fail("review alignment is invalid")
    confidence = review.get("confidence")
    if (
        review.get("novelty") not in levels
        or isinstance(confidence, bool)
        or not isinstance(confidence, (int, float))
        or not math.isfinite(confidence)
        or confidence < 0
        or confidence > 1
    ):
        fail("review novelty or confidence is invalid")
    if not isinstance(review.get("vacuous"), bool):
        fail("review vacuity judgment is invalid")
    criteria = review.get("criteria")
    shortcuts = review.get("shortcuts")
    if not isinstance(criteria, list) or sorted(item.get("id") for item in criteria if isinstance(item, dict)) != criterion_ids:
        fail("review criteria do not match the frozen scope")
    if not isinstance(shortcuts, list) or sorted(item.get("id") for item in shortcuts if isinstance(item, dict)) != shortcut_ids:
        fail("review shortcuts do not match the frozen scope")
    if any(item.get("status") not in {"passed", "failed", "inconclusive"} for item in criteria):
        fail("review criterion status is invalid")
    if any(not isinstance(item.get("observed"), bool) for item in shortcuts):
        fail("review shortcut judgment is invalid")
    evidence_sets = [review.get("evidence"), *[item.get("evidence") for item in criteria], *[item.get("evidence") for item in shortcuts]]
    if any(not isinstance(items, list) or not items or not all(isinstance(ref, str) and ref for ref in items) for items in evidence_sets):
        fail("every review judgment needs observable evidence")
    literature = review.get("literatureRefs")
    if floor != "not_required" and (
        not isinstance(literature, list) or not literature or not all(isinstance(ref, str) and ref for ref in literature)
    ):
        fail("novelty review needs frozen-scope literature evidence")
    actor = review["actor"]
    if review["correctness"] == "failed":
        incorrect.append(f"{actor}:correctness_failed")
    if review["correctness"] == "inconclusive" or review["alignment"] == "ambiguous" or review["confidence"] < threshold:
        uncertain.append(f"{actor}:uncertain")
    if any(item.get("status") == "inconclusive" for item in criteria):
        uncertain.append(f"{actor}:criterion_inconclusive")
    if review["alignment"] == "misinterpreted" or review.get("vacuous"):
        technical.append(f"{actor}:intent_or_vacuity")
    if any(item.get("status") == "failed" for item in criteria) or any(item.get("observed") for item in shortcuts):
        technical.append(f"{actor}:criterion_or_shortcut")
    if levels[review["novelty"]] < levels[floor]:
        technical.append(f"{actor}:below_novelty_floor")

status = "failed" if incorrect else "ambiguous" if uncertain else "technical_only" if technical else "meaningful"
print(json.dumps({
    "valid": True,
    "derivedStatus": status,
    "reviewers": len(reviews),
    "subject": subject,
    "objectiveSHA256": scope["objectiveSHA256"],
    "failures": [*incorrect, *uncertain, *technical],
}, sort_keys=True))
