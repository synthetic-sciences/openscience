---
name: scientific-ablation-design
description: Design and validate controlled ablations for a benchmark, agent architecture, model, or scientific pipeline. Use when attributing a measured improvement to orchestration, memory, search, tools, training choices, simulators, or another claimed mechanism.
---

# Scientific Ablation Design

Turn “this component helped” into a predeclared, budget-matched contrast.

## Define claims before results

For every claimed mechanism, write:

- one named factor;
- its full-system value and ablated value;
- the predicted direction and primary metric;
- the failure observation that would weaken the claim; and
- any interaction that cannot be identified by a one-factor contrast.

Do not create ablations only for components that look favorable after the main run.

## Match the experimental context

Use the same evaluator version, held-out split, model, prompt/template, tool policy, candidate budget, wall-time/compute cap, seeds, stopping rule, and contamination policy for baseline and isolation arms. Change exactly one factor per isolation arm.

Add interaction arms only when explicitly declared. Label multi-factor arms as interactions; do not report them as isolated causal evidence.

## Validate the matrix

Create a plan JSON:

```json
{
  "metric":{"name":"score","direction":"maximize"},
  "baseline":{"id":"full","config":{"memory":"verified","search":"ucb"},"seeds":[1,2,3],"budget":{"candidates":30},"split":"held_out","evaluator":"eval-sha"},
  "claims":[{"id":"memory-value","factor":"memory","from":"verified","to":"none"}],
  "arms":[{"id":"no-memory","config":{"memory":"none","search":"ucb"},"seeds":[1,2,3],"budget":{"candidates":30},"split":"held_out","evaluator":"eval-sha"}]
}
```

Run:

```bash
python scripts/validate_ablation_plan.py ablations.json --output ablation-report.json
```

The validator rejects missing isolation arms, multiple changes disguised as one ablation, seed/budget/split/evaluator drift, duplicate IDs, and claims whose declared baseline value is false.

## Execute and analyze

1. Run arms in a randomized or interleaved order when shared infrastructure can drift.
2. Preserve all seeds and failures.
3. Compute paired seed-level differences when pairing is valid.
4. Report effect size and uncertainty, not only whether the mean changed.
5. Correct for multiplicity across many factors or predeclare one primary contrast.
6. Inspect quality-cost Pareto changes; a score gain bought by materially more compute is not an isolated method gain.
7. Keep the claim weakened when effects are unstable, interaction-dependent, or below practical relevance.

## Guard against invalid attribution

Do not accept:

- a different evaluator or data split;
- unequal search or training budget;
- cherry-picked seeds;
- an arm that changes prompts, models, tools, and component simultaneously;
- a comparison to an obsolete baseline when a stronger matched parent exists; or
- internal reviewer preference as a substitute for the declared metric.
