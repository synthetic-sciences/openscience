---
name: design-benchmark-objectives
description: Predeclare and audit primary and secondary metrics for an OpenScience optimization benchmark. Use when adding multi-metric Pareto search, designing evaluator rewards or constraints, checking a benchmark metric for Goodhart or leakage risk, or turning an evaluator specification into a content-addressed HarnessAdapter objective contract before candidate search.
---

# Design Benchmark Objectives

Keep the benchmark's official score authoritative while using auxiliary metrics to preserve useful diversity.

## Separate optimization from claims

Name distinct `optimizationSplit` and `claimSplit` values. Search may repeatedly evaluate the optimization split. Reserve the claim split for post-search confirmation; no objective signal or guard used during search may read it.

Pin the evaluator by name, version, SHA-256, and owner. The owner must be `evaluator`. Candidate-authored measurements and self-reported scores are not objectives.

## Predeclare every metric

Create one primary metric and at most eight secondary objectives:

```json
{
  "schemaVersion": 1,
  "benchmark": {
    "id": "mle",
    "optimizationSplit": "validation",
    "claimSplit": "official-hidden",
    "evaluator": {"name": "official-evaluator", "version": "2026.08", "sha256": "64-lowercase-hex", "owner": "evaluator"}
  },
  "primary": {"metric": "score", "direction": "maximize", "unit": "fraction", "official": true, "anchors": {"poor": 0.2, "good": 0.8}},
  "objectives": [{
    "metric": "robustness",
    "direction": "maximize",
    "role": "diversity",
    "unit": "fraction",
    "signal": "validation-perturbations",
    "anchors": {"poor": 0.3, "good": 0.7},
    "risks": ["may reward invariance to scientifically meaningful changes"],
    "guardIDs": ["semantic-regression"]
  }],
  "signals": [{
    "id": "validation-perturbations",
    "owner": "evaluator",
    "scope": "optimization",
    "candidateReadable": false,
    "valueRelease": "after_final",
    "sourceSHA256": "64-lowercase-hex"
  }],
  "guards": [{
    "id": "semantic-regression",
    "kind": "regression",
    "argv": ["python", "eval_semantics.py", "--held-back"],
    "blocking": true,
    "scope": "optimization",
    "sourceSHA256": "64-lowercase-hex",
    "protects": ["robustness"]
  }],
  "policy": {
    "winnerMetric": "score",
    "targetMetric": "score",
    "archive": "pareto",
    "promotion": "final_only",
    "missingObjective": "reject",
    "valueRelease": "after_final",
    "claimSplitUsage": "post_search_only",
    "candidateCanReadObjectiveValues": false
  }
}
```

Use numeric `poor` and `good` anchors to make direction mistakes executable. Give every proxy a concrete gaming risk and at least one blocking non-resource guard. Guards are argv programs, not shell commands.

## Audit before binding

Run the bundled standard-library validator:

```bash
python scripts/audit_objectives.py commitments
python scripts/audit_objectives.py audit objectives.json --output objective-audit.json
```

The report includes the raw input hash, canonical plan hash, validator hash, the complete normalized safety contract, passed checks, and an `adapterPatch` containing `profile`, `metric`, `objectives`, and `objectiveAudit`. Pass those adapter fields unchanged when binding the task. The backend requires the audit for adapter-bound secondary objectives and includes it in report comparison identity.

## Fail closed

Do not start optimization when the audit rejects. In particular:

- never scalarize secondary metrics into the official winner or target;
- never infer direction from a metric name;
- never use claim-split data, candidate-readable measurements, or during-run objective values;
- never admit a passing final candidate with an incomplete metric vector;
- never accept a proxy whose only protection is a resource threshold; and
- never edit the objective plan after observing candidate results. Create a new contract and comparison family instead.
