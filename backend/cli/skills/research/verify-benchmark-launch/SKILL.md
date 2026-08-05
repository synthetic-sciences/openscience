---
name: verify-benchmark-launch
description: Execute a fail-closed readiness audit for an official scientific or ML benchmark checkout. Use when binding a held-out or release harness run, onboarding a benchmark repository, reproducing an official baseline, or verifying that runner, environment, dataset, task manifest, evaluator, hidden boundary, deterministic replay, and artifact round-trip are pinned before agent execution.
---

# Verify Benchmark Launch

Validate bytes and replay artifacts inside the evaluator-owned launcher. Do not run this workflow from the candidate-producing agent session, and do not place its manifest or outputs inside the checkout being tested.

## Prepare the hidden-boundary probe

Place one evaluator-owned canary file in every hidden mount. Run the fixed probe from inside the exact sandbox, container, VM, or account that will host the agent:

```bash
python scripts/validate_launch.py probe-boundary \
  --agent-root /agent/workspace \
  --hidden-path /evaluator/hidden/canary-a \
  --hidden-path /evaluator/hidden/canary-b \
  --output /evaluator/evidence/boundary.json
```

The probe exits nonzero if it can read any canary. Its receipt contains path commitments, not hidden paths or bytes. Hash that receipt for the launch manifest.

## Capture real replay artifacts

Before validation:

1. Check out the official repository at an exact 40- or 64-hex revision.
2. Materialize the locked environment without editing the checkout.
3. Run the exact official command twice with the same frozen task, data, seed, and hardware policy.
4. Export and re-import one scored artifact through the benchmark's real serialization path.
5. Replay the pinned public baseline and save its numeric score as JSON.

Keep the two replay outputs, round-trip artifacts, baseline artifact, score file, dataset, and boundary receipt under evaluator control.

## Build the launch manifest

Create JSON matching this shape. Paths are relative to the manifest unless they are absolute. Relative paths inside `workspace`, `dataset.root`, or `resultsRoot` may not escape those roots, including through symlinks.

```json
{
  "schemaVersion": 1,
  "workspace": "/evaluator/checkouts/benchmark",
  "resultsRoot": "/evaluator/results/run-17",
  "runner": {
    "repository": "https://github.com/owner/official-benchmark",
    "revision": "40-or-64-lowercase-hex",
    "entrypoint": "benchmark/run.py",
    "command": ["python", "benchmark/run.py", "--task", "task-17"],
    "commandSHA256": "sha256-of-canonical-command-array",
    "recipe": {
      "artifact": "/evaluator/evidence/materialized-recipe.json",
      "artifactSHA256": "64-hex",
      "recipeSHA256": "64-hex",
      "driverSHA256": "64-hex"
    },
    "environment": {
      "files": ["pyproject.toml", "uv.lock"],
      "sha256": "sha256-of-sorted-path-and-file-hash-records"
    }
  },
  "dataset": {
    "name": "official-data",
    "source": "https://example.org/dataset",
    "root": "/evaluator/data/official-data",
    "revision": "release-2026-08",
    "revisionFile": "REVISION",
    "manifest": "manifest.json",
    "manifestSHA256": "64-hex"
  },
  "task": { "manifest": "tasks/task-17.json", "sha256": "64-hex" },
  "evaluator": { "artifact": "benchmark/evaluate.py", "sha256": "64-hex" },
  "boundary": {
    "receipt": "/evaluator/evidence/boundary.json",
    "receiptSHA256": "64-hex",
    "agentRoot": "/agent/workspace",
    "hiddenCommitments": ["64-hex"]
  },
  "replay": { "first": "replay-1.json", "second": "replay-2.json" },
  "roundtrip": { "exported": "artifact-export.bin", "imported": "artifact-import.bin" },
  "baseline": {
    "name": "official-baseline",
    "artifact": "baseline.bin",
    "artifactSHA256": "64-hex",
    "scoreFile": "baseline-score.json",
    "scoreKey": "metrics.score",
    "expectedScore": 0.5,
    "tolerance": 1e-9
  }
}
```

Derive command and environment hashes with canonical JSON: UTF-8, sorted object keys, and separators `,` and `:`. The validator reports the observed hashes on mismatch; never weaken the manifest to make a failed checkout pass.

For adapters whose `/harness/benchmarks` manifest reports `recipe.status: source_verified`, materialize the recipe through `POST /harness/benchmarks/:benchmark/recipe`, save the exact response outside the candidate workspace, and include the optional `runner.recipe` block above. The validator independently checks the response bytes, native launch-stage driver digest, recipe commitment, and entrypoint. Omit the block only for adapters that explicitly report a pending or not-applicable recipe; held-out/release runs for a source-verified adapter will reject that omission.

## Validate and bind

Run:

```bash
python scripts/validate_launch.py validate launch.json --output launch-report.json
```

Exit code `0` means all eight `benchmark-launch-v1` checks passed, `1` means a well-formed launch failed readiness, and `2` means the input was invalid. The report contains:

- the exact launch protocol to bind in `POST /harness/runs`;
- validator name, version, script SHA-256, and input-manifest SHA-256;
- eight API-compatible check records with observed evidence hashes;
- the independently read baseline score; and
- explicit failures without bearer capabilities or hidden content.

Bind the report's `protocol` before the agent starts. Submit its `validator`, `checks`, `baselineScore`, and report reference through `/harness/launches/receipts`. Start search or orchestration only after the returned receipt passes.

## Reject the launch

Stop instead of substituting components when:

- Git origin, revision, or cleanliness differs;
- a source-verified recipe artifact, native driver, or entrypoint differs;
- any lock, dataset, task, evaluator, or baseline byte hash differs;
- a hidden canary is readable from the agent sandbox;
- deterministic outputs or serialization round-trips differ byte-for-byte;
- the public baseline misses its frozen tolerance; or
- the validator report does not match the protocol ultimately bound to the run.
