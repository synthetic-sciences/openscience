# Replicated evaluation protocol

## Frozen design

`replicated-evaluation-v1` defines an exact crossed design:

- `sampling.strata`: benchmark tasks, folds, sites, datasets, or other declared conditions.
- `sampling.clusters`: independent seeds, trials, reproductions, operators, or laboratories.
- admissible units: the complete Cartesian product of the two axes.
- `commitmentSHA256`: evaluator-owned commitments to each frozen axis configuration.
- `environmentSHA256`: evaluator-owned commitment to the exact runtime, dependencies, tools, and simulator configuration used by every unit.

Use one stratum when only independent repetitions are needed. Use several strata when performance must aggregate across tasks or conditions. Declare at least five genuinely independent clusters for numeric bootstrap estimators and at least three for pass-rate Wilson intervals. If two observations share the highest-level source of randomness or execution, they belong to one cluster.

## Aggregation

For `mean`, `median`, and `iqm`, every unit must pass and carry a finite score. The backend draws strata with replacement, then draws clusters independently with replacement inside each selected stratum using the frozen deterministic seed. It recomputes the estimator for each draw and takes the 2.5% and 97.5% percentile endpoints. IQM is the mean of the empirical quantile function between 25% and 75%. Use 50,000 resamples for publication or leaderboard reports when runtime permits; 1,000 is the contract minimum.

For `pass_rate`, declare exactly one stratum so each cluster is one independent Bernoulli outcome. Observations carry only `passed`, `failed`, or `inconclusive`. The backend computes the pass fraction and a 95% Wilson score interval. An inconclusive unit makes the receipt inconclusive. For pass fractions across several tasks, encode `0`/`1` as numeric scores and use the stratified-bootstrap mean instead.

Promotion uses the conservative endpoint:

- `maximize` or `pass`: lower endpoint must be at least the frozen target.
- `minimize`: upper endpoint must be at most the frozen target.
- when `maxIntervalWidth` is set, the interval must also be no wider than that limit.

The final evaluation score must exactly equal the backend estimate. The best unit, median seed chosen after inspection, and point estimate cannot authorize promotion.

## Submission shape

```json
{
  "sessionID": "bound-session",
  "evaluatorToken": "inject out-of-band at request time; never persist in the preflight file",
  "subject": { "type": "run", "id": "bound-run" },
  "observations": [
    {
      "stratumID": "task-0",
      "clusterID": "seed-0",
      "stratumSHA256": "must equal the stratum commitmentSHA256",
      "clusterSHA256": "must equal the cluster commitmentSHA256",
      "status": "passed",
      "score": 0.83,
      "outputSHA256": "64 lowercase hex characters",
      "environmentSHA256": "must equal replication.environmentSHA256",
      "evidence": ["artifact:task-0/seed-0/result.json"],
      "evaluatedAt": 1780000000000
    }
  ]
}
```

Use `{ "type": "candidate", "id": "<candidate SHA>" }` only after that immutable candidate exists. Every observation must occur after subject creation and before receipt recording. Record the receipt before the subject's final evaluation.

One subject can freeze only one receipt. An exact submission retry is idempotent; changed observations are rejected instead of creating a favorable alternate receipt. Use a new immutable run or candidate subject for a genuinely predeclared new experiment.

## Failure interpretation

- Missing or extra unit, or changed axis commitment: invalid request; restore the frozen grid and committed configuration.
- Duplicate unit or axis commitment: invalid independence claim; correct the design, not the score.
- Numeric failed/inconclusive unit: fail-closed receipt with no aggregate.
- Pass-rate inconclusive unit: inconclusive receipt.
- Bound misses target or interval is too wide: failed receipt; gather a new predeclared run rather than editing this receipt.
- Receipt hash, protocol, environment, session, subject, metric, timestamp, or derived-statistic mismatch: reject as drift, tampering, or replay.
