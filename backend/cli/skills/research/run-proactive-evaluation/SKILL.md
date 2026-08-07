---
name: run-proactive-evaluation
description: Build, execute, calibrate, and seal OpenScience proactive-audit-v2 evaluations with a backend-derived score-history Gaussian-process prior. Use when costly held-out population evaluation should use ProEval-style Bayesian-quadrature selection, when negative transfer must fail closed, or when a passing final evaluation requires a content-addressed active-audit receipt without exposing hidden cases.
---

# Run Proactive Evaluation

Keep source scores, hidden cases, and the evaluator capability outside the candidate-producing agent. Use the script to commit the exact transfer pool before binding a run.

## Prepare the frozen pool

Create evaluator-private JSONL with `id`, `hidden`, `sourceLosses`, `stratum`, and optional `weight`. Every loss vector must follow the same source-model order. Create a token-free protocol JSON containing:

- unique `sourceModels` (at least three);
- `selectionSHA256` for the source-profile selection artifact;
- `selectionMethod`: `pca-gmm-profile-v1` or `holdout-embedding-gmm-v1`;
- `calibrationSamples`; and
- `maxCalibrationMAE`.

Run inside the secret-owning evaluator environment:

```bash
bun scripts/preflight.ts \
  --input private-probes.jsonl \
  --protocol transfer-protocol.json \
  --out proactive-audit.json
```

The output contains only commitments, source losses, strata, weights, the exact `poolSHA256`, and a backend-compatible `sourceManifestSHA256` derived from the ordered source IDs and score matrix. It never contains hidden bytes or a capability. Do not edit the generated probes or transfer object.

## Bind and execute

1. Put the generated `transfer` object under `audit.transfer` in the immutable run contract. Set `promotionRequired: true` only for `performance` or `hybrid` mode.
2. Initialize `POST /harness/audits` with the generated `probes`, the exact run/candidate artifact hash, and the in-memory evaluator capability.
3. Call `/selection` once per round. Resolve the returned commitment to the private hidden case. Calibration selections must report `phase: calibration`.
4. Evaluate the frozen subject and submit one threshold-consistent loss, failure label, and evidence record to `/observations`.
5. Continue after `transfer.status: accepted`. If it becomes `rejected`, preserve `abstain: true`; remaining `fallback` selections are diagnostic and cannot qualify promotion.
6. Stop only at persisted terminal state. Seal it with `POST /harness/audits/:auditID/receipt`.
7. Add the returned `receiptID` as `auditReceiptID` on the ordinary authenticated final evaluation. Never use the audit estimate as the official benchmark score.

## Integrity rules

- Never provide `features` or `priorLoss` in v2. OpenScience derives the empirical mean and covariance features from `sourceLosses`.
- Never change the pool, source order, manifests, selection artifact, thresholds, subject artifact, or failure definition after binding.
- Never mix generated, synthesized, adaptively authored, or manually cherry-picked cases into the committed population pool. Run them as a separate failure-discovery stream.
- Treat a missing, corrupt, mismatched, future, abstaining, or unqualified receipt as a failed promotion gate.
- Treat byte-identical selection, observation, and sealing retries only as transport recovery.

## Stop conditions

Stop before evaluation on pool-digest mismatch, source dimension drift, fewer than three source models, hidden-byte exposure, capability exposure, unresolvable commitments, or subject substitution. Stop promotion when calibration rejects transfer, the terminal estimate abstains, or the receipt does not match the exact contract and subject.
