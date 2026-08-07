---
name: run-replicated-evaluation
description: Prepare, execute, and preflight an evaluator-owned OpenScience replicated-evaluation receipt over a frozen stratum-by-independent-cluster grid. Use when a bound replicated-evaluation-v1 contract requires mean, median, IQM, or pass-rate aggregation with a confidence bound before a run or candidate may receive its final benchmark evaluation.
---

# Run Replicated Evaluation

Operate this skill in the evaluator process. Keep the evaluator capability outside agent-visible artifacts.

1. Read the immutable harness contract and locate `replication`. Stop if it is absent.
2. Read [references/protocol.md](references/protocol.md) before constructing a payload.
3. Materialize every declared `stratum × cluster` unit exactly once. Treat `clusterKind` as the highest independent sampling unit; never turn repeated measurements, checkpoints, timesteps, or metrics from one cluster into extra clusters.
4. Execute all units under the exact `replication.environmentSHA256` commitment. Preserve failed and inconclusive units instead of replacing or omitting them.
5. Record the matching stratum and cluster commitment hashes plus one immutable output hash, environment hash, timestamp, and evidence set per unit. Numeric estimators require a score only for passed units. `pass_rate` uses statuses and accepts no submitted numeric score.
6. Run:

   ```bash
   python3 scripts/preflight.py contract.json observations.json
   ```

7. Submit the complete body to `POST /harness/replications/receipts` with the bound evaluator capability. Treat the preflight as advisory; only the backend receipt is authoritative. Exact retries return the frozen receipt; changed retries for the same subject are forbidden.
8. Reference the returned `receiptID` in the final evaluation. Set the final score and bound metric to `receipt.statistics.estimate`. A passing evaluation requires `receipt.status == "passed"`.

Do not select a favorable subset, retry only failed units, change strata or clusters after seeing results, report the best replicate, or replace the conservative bound with the point estimate. A failed or inconclusive receipt remains durable evidence.
