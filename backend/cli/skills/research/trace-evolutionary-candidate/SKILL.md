---
name: trace-evolutionary-candidate
description: Build an evaluator-owned, content-addressed source snapshot and exact parent-delta submission for an OpenScience optimization candidate. Use before recording a final candidate evaluation when the harness contract binds evolution-trace-v1, or when evolutionary search lineage, deterministic replay, source novelty, ancestral code reintroduction, or cycle diagnostics must be independently auditable.
---

# Trace Evolutionary Candidate

Run this skill in the evaluator process, never in the candidate agent. It scans the contract-frozen source roots, creates a canonical manifest, verifies every local parent against its already-recorded snapshot, writes deterministic delta artifacts, and builds the token-free body for `POST /harness/evolution/receipts`.

## Workflow

1. Freeze `evolution-trace-v1` before search. Pin the exact SHA-256 of `scripts/trace_candidate.py` and [references/manifest-schema.json](references/manifest-schema.json), plus source roots, extensions, exclusions, and resource bounds.
2. Capture candidate and parent worktrees outside the candidate sandbox. Do not accept a candidate-authored manifest, diff, or line count.
3. Record every passing parent trace before admitting a child. Each parent specification must name its candidate artifact, receipt, snapshot artifact, and exact local root.
4. Run the builder. It rejects symlinks, invalid UTF-8, omitted or substituted parent snapshots, duplicate paths, out-of-scope files, and bound violations. It hashes exact non-empty line bytes; indentation and carriage returns are significant.
5. Inject `evaluatorToken` only into the authenticated request in memory. Never write it into the submission, report, manifest, or delta artifacts.
6. Record the returned receipt before the final candidate evaluation and reference it as `evolutionReceiptID`.
7. Treat `cycleDetected`, `reintroducedLines`, and novelty diagnostics as analysis only. They are not benchmark scores and cannot verify or promote a candidate.

## Commands

Print exact validator and manifest-schema commitments:

```bash
python scripts/trace_candidate.py commitments
```

Build a root-candidate submission:

```bash
python scripts/trace_candidate.py build \
  --contract contract-evolution.json \
  --subject candidate.json \
  --candidate-root ./candidate-worktree \
  --artifact-dir ./trace-artifacts \
  --run-id run-123 \
  --session-id session-123 \
  --output evolution-submission.json \
  --report evolution-diagnostics.json
```

For a descendant, repeat `--parent` once per declared parent:

```bash
python scripts/trace_candidate.py build \
  --contract contract-evolution.json \
  --subject child.json \
  --candidate-root ./child-worktree \
  --parent parent-a.json \
  --parent parent-b.json \
  --artifact-dir ./trace-artifacts \
  --run-id run-123 \
  --session-id session-123 \
  --output evolution-submission.json
```

## Inputs

- `contract-evolution.json`: the exact `HarnessContract.Evolution` value.
- `candidate.json`: `{ "type": "candidate", "id": "<sha256>", "artifact": { "uri": "...", "sha256": "<sha256>" } }`.
- `parent-*.json`: `{ "id": "<candidate sha256>", "artifact": {...}, "receiptID": "<sha256>", "snapshot": { "uri": "...", "sha256": "<sha256>" }, "root": "./exact-parent-worktree", "deltaURI": "optional stable URI" }`.
- `--candidate-root`: exact unpacked candidate artifact, captured by the evaluator.

The output intentionally omits `evaluatorToken`. Its snapshot and delta URIs remain replay references; their SHA-256 values bind exact canonical bytes.

## Fail-Closed Rules

- Scan only contract-frozen roots and extensions, while honoring every committed exclusion.
- Reject symlinks instead of following them across the capture boundary.
- Reject invalid UTF-8 instead of silently treating binary data as source.
- Hash exact non-empty byte lines split only on LF. Do not trim whitespace or normalize CRLF.
- Require local parent manifests to match the immutable snapshot hashes in their specifications.
- Require one parent specification for every declared search parent and no others.
- Do not infer fitness, edit semantics, or scientific novelty. The backend recomputes structural deltas and ancestral reintroductions; the benchmark evaluator remains the sole fitness authority.
