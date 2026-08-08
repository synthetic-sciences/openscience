---
name: verify-benchmark-integrity
description: Build an evaluator-owned runtime-integrity submission from a normalized JSONL execution trace, measured model lineage, independently produced contamination/API/benchmark-lookup audit verdicts, and hidden canaries. Use before recording a final OpenScience benchmark evaluation when benchmark test-item derivation, unauthorized model use, model substitution, lookup leakage, or incomplete traces must fail closed.
---

# Verify Benchmark Integrity

Use this skill in the evaluator process, never inside the candidate agent. It produces the evidence-bearing input for `POST /harness/integrity/receipts`; the backend independently derives the final six checks and immutable receipt.

## Workflow

1. Freeze `benchmark-integrity-v1` in the harness contract before execution. Pin the exact SHA-256 of `scripts/verify_integrity.py`, the bundled trace schema, assigned base-model artifacts, independent auditor prompts, and hidden-canary manifest.
2. Capture events outside the candidate sandbox using the normalized format in [references/trace-schema.json](references/trace-schema.json). Candidate-authored logs are not an acceptable trace source.
3. Measure model identity and lineage into `model.json`. Hash exact bytes or canonical artifacts; do not accept a model self-description.
4. Run the three committed auditors independently over the frozen trace and artifacts. Store their exact identities, decisions, confidence, and evidence in `audits.json`. A judge abstention is preserved and fails the backend gate.
5. Run the validator. It checks sequence/timestamp structure, computes the trace hash, counts dropped events, derives unapproved model calls and benchmark lookups, deduplicates hidden canaries, checks every committed identity, and emits a submission without the evaluator token.
6. Inject the evaluator capability only in the authenticated request. Never write the token into the submission or evidence files.
7. Reference the returned receipt in the final evaluation. A failed receipt is still durable evidence; do not discard or rewrite it.

## Commands

Print the exact validator and trace-schema commitments:

```bash
python scripts/verify_integrity.py commitments
```

Build a submission and a human-readable diagnostic report:

```bash
python scripts/verify_integrity.py build \
  --contract contract-integrity.json \
  --trace normalized-trace.jsonl \
  --subject subject.json \
  --model model.json \
  --audits audits.json \
  --run-id run-123 \
  --session-id session-123 \
  --output integrity-submission.json \
  --report integrity-diagnostics.json \
  --evidence artifact:trace-capture-attestation.json \
  --evidence artifact:auditor-bundle.json
```

The output intentionally omits `evaluatorToken`. Add it only in memory immediately before the API call.

## Required Inputs

- `contract-integrity.json`: the exact `HarnessContract.Integrity` object.
- `subject.json`: `{ "type": "run|candidate", "id": "...", "artifact": { "uri": "...", "sha256": "..." } }`.
- `model.json`: assigned name, base/config/output artifact hashes, and an evaluator-measured `lineageVerified` boolean.
- `audits.json`: exactly one result for each of `test_item_contamination`, `external_model_use`, and `benchmark_lookup`, matching the precommitted name, version, and prompt hash.
- `normalized-trace.jsonl`: contiguous evaluator-owned events matching the bundled schema.

## Fail-Closed Rules

- Reject malformed, non-contiguous, or time-reversing traces instead of guessing coverage.
- Count explicit `trace_gap.dropped` values in the backend coverage denominator.
- Treat every `model_call` without `approved: true` as unapproved.
- Count every `benchmark_lookup` event; renamed or post-processed events are not exempt.
- Count unique canary IDs only, reject duplicate IDs, and reject mixed canary manifests.
- Preserve flagged and abstaining auditor decisions. The validator does not convert semantic judgments to clean.
- Never claim this script discovers semantic contamination by itself. It validates committed independent verdicts and derives observable trace counts; the backend authenticates and freezes the result.
