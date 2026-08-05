---
name: design-replay-interventions
description: Build and validate an evaluator-owned OpenScience controlled intervention plan for an evolved candidate. Use when an intervention-study-v1 contract requires same-condition replay, constants-only retuning, component ablation, repair, or model, context, evaluator, or split transfer evidence before final candidate promotion.
---

# Design Replay Interventions

Run this skill in the evaluator process after the candidate's evolution trace is recorded and before its final evaluation. It validates exact one-difference pairs and creates the token-free body for `POST /harness/interventions`.

## Workflow

1. Freeze `intervention-study-v1` in the run contract before search. Choose required families, pair limits, a 95% confidence policy, direction-aware thresholds, and the exact SHA-256 of `scripts/design_interventions.py`.
2. Select the candidate and its exact `evolutionReceiptID`. Never accept candidate-authored intervention plans, transforms, contexts, or outcome evidence.
3. Build at least the contract's `minPairs` pairs per required family. Use distinct seeds or cases. Each pair has exact control and arm artifacts, model, context, evaluator, split manifest, environment, and budget commitments.
4. Make only the family-permitted change:
   - `replay`: no target or condition change; execute the same cell independently.
   - `retune`, `ablation`, `repair`: change only the artifact; the arm must be the study candidate.
   - `model_transfer`, `context_transfer`, `evaluator_transfer`, `split_transfer`: change only the named condition; both cells use the study candidate.
5. Run the builder. It rejects missing families, sparse indexes, duplicated pairs, wrong rule modes, excess pairs, and every uncommitted extra difference.
6. Inject `evaluatorToken` only into the authenticated initialization request in memory. Never write it to the plan, pair report, evidence, or logs.
7. Execute both cells independently and record each exact target with `POST /harness/interventions/:candidateID/observations`.
8. Call the assessment only after every frozen outcome is recorded. The backend recomputes paired effects, t intervals, replay stability, tuning gap, component dependence, recovery, and transfer robustness.
9. Reference the passing `interventionReceiptID` on the later final candidate evaluation when `requiredForPromotion` is true.

## Commands

Print the immutable validator commitment:

```bash
python scripts/design_interventions.py commitments
```

Validate a protocol and pair specification, then build a token-free request and target ledger:

```bash
python scripts/design_interventions.py build \
  --contract intervention-contract.json \
  --spec intervention-pairs.json \
  --output intervention-initialize.json \
  --report intervention-targets.json
```

See [references/spec-schema.json](references/spec-schema.json) for the exact input shape.

## Interpretation

- Replay passes only when every absolute paired score difference stays within its frozen threshold.
- Retuning, ablation, and repair use a direction-aware lower 95% confidence bound above `min_effect`, with no regressing pair.
- Transfer passes only when no pair exceeds `max_regression` and the lower 95% confidence bound remains above the negative threshold.
- Failed or missing executions produce a failed receipt, not a silently smaller sample.
- These results qualify causal or robustness claims. They never become candidate fitness, a benchmark score, or proof of scientific novelty.

## Fail-Closed Rules

- Freeze the matrix before the candidate's final evaluation.
- Bind the exact candidate artifact and prior evolution receipt.
- Keep pair indexes contiguous from zero within every family.
- Use a content-addressed `change` artifact to identify the transform or execution protocol for every pair.
- Do not reuse a score or evidence item across nominally independent repetitions.
- Do not infer a semantic constants-only edit or valid ablation from a filename. The evaluator must generate and verify transforms outside the candidate sandbox.
- Treat an inconclusive confidence interval as inconclusive, never as a pass.
