# Workflow: compare

<invocation>
$ARGUMENTS
</invocation>

## Admission contract

Resolve every target to an exact run, artifact version, method, model, dataset, or claim. Freeze the decision question and comparison criterion before calculating differences.

Build a matched-basis ledger covering:

- population or dataset identity, split, and preprocessing;
- code, environment, hardware, and dependency version;
- training or compute budget, stopping rule, seeds, and sample count;
- metric definition, direction, units, aggregation, and uncertainty method;
- missing values, exclusions, failed runs, and selection procedure.

If a material field is unmatched, label the comparison confounded. Do not normalize away an incompatibility or force a ranking.

## Procedure

1. Prefer immutable artifacts and provenance records to copied summary numbers.
2. Validate identities, units, shapes, denominators, and metric direction before arithmetic.
3. Recompute decisive metrics from source artifacts when practical. Preserve paired structure for paired data and repeated seeds.
4. Quantify absolute difference, relative difference where the denominator is meaningful, variability or interval estimates, and practical significance.
5. Separate observed values from causal interpretation. Name every remaining confounder and sensitivity to the decision rule.
6. When new execution is needed, use a compatible research contract, record failed candidates, and save the comparison table and code as durable Results.

## Output table

Include one row per target and columns for identity, version, data or split, budget, sample or seed count, decisive metric with units, uncertainty, validation state, and material caveat. Add a second compact table for pairwise differences when more than two targets are present.

## Terminal condition

Return exactly one conclusion:

- `WINNER: <target>` when the frozen criterion and evidence support a unique winner.
- `TIE` when the criterion treats the results as equivalent.
- `TRADEOFF` when different targets win on different declared dimensions.
- `INSUFFICIENT EVIDENCE` when mismatch, uncertainty, or missing evidence prevents a fair decision.

Name the next discriminating check for every non-winner conclusion.
