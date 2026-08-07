---
name: active-failure-audit
description: Build and run a blinded, commitment-bound active evaluation over a costly hidden probe pool. Use when full evaluation is too expensive, when diverse failure discovery matters, or when a benchmark needs uncertainty-aware sample selection without exposing hidden cases to the agent.
---

# Active Failure Audit

Use an evaluator-owned probe pool to estimate loss and search for diverse failures under a fixed budget. Keep this workflow outside the candidate-producing agent session.

## Freeze the protocol

Before evaluating, pin:

- the exact run or candidate artifact SHA-256;
- `performance`, `failure`, or `hybrid` mode;
- the probe budget and minimum sample count;
- the loss definition and frozen failure threshold;
- the precision tolerance and abstention threshold;
- the feature representation, strata, and evaluation weights; and
- an optional target number of distinct failures.

Do not tune these fields after seeing outcomes.

## Build opaque probe commitments

Prepare evaluator-private JSONL with one object per hidden case:

```json
{"id":"case-17","hidden":{"prompt":"...","target":"..."},"features":[0.2,-1.1,0.4],"stratum":"long-tail","weight":1,"priorLoss":0.5}
```

Run:

```bash
python scripts/build_probe_manifest.py private-probes.jsonl public-manifest.json
```

The script validates one shared finite feature dimension, unique IDs, and unique hidden-case bytes. It emits only opaque IDs, numeric features, strata, weights, prior loss, and SHA-256 commitments. Keep the private JSONL outside the agent workspace. Do not use the generated manifest if its validation fails.

## Run the audit

1. Bind the audit configuration in the immutable harness contract.
2. Initialize `/harness/audits` with the evaluator capability, frozen subject artifact, and generated `probes` array.
3. Request one `/selection` at a time. Resolve the returned commitment to the private case inside the evaluator boundary.
4. Evaluate the frozen artifact. Submit loss, threshold-consistent failure label, and observable evidence to `/observations`.
5. Resume through `/status` after interruption. A pending selection is idempotent.
6. Stop only when the persisted state reports a terminal reason.

Never send hidden text, targets, or expected outputs to OpenScience. Treat numeric features as fixed side information, not agent-generated descriptions of benchmark answers.

## Interpret the result

Report posterior mean loss, standard deviation, 95% interval, discovered failures, stratum coverage, sample count, pool fingerprint, artifact hash, and stop reason. Preserve `abstain: true` whenever the minimum sample count or uncertainty requirement is unmet.

An active-audit estimate is not an official benchmark score. Attach its immutable receipt to a separately authenticated evaluation before using it as evidence.

## Failure checks

Reject the audit if:

- probe bytes, feature vectors, weights, or thresholds changed;
- the evaluator capability or artifact hash does not match;
- selected cases cannot be resolved back to their commitments;
- failure labels contradict the frozen threshold;
- one observation is overwritten; or
- only favorable strata or failure types are reported.
