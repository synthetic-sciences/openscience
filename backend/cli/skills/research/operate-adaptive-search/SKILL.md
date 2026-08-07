---
name: operate-adaptive-search
description: Execute an OpenScience adaptive-search-v1 recommendation or reservation lease. Use when a benchmark optimization run supplies a strategy, target island, verified lineage, controller snapshot, or agentic variation mandate and the next worker must produce one compliant candidate artifact without overriding evaluator-owned routing or fitness.
---

# Operate Adaptive Search

Treat the lease as the authorized search action. Produce one new runnable artifact; never rewrite its lineage, target island, controller fields, or mandate.

## Workflow

1. Save the supplied recommendation JSON and run `python3 scripts/validate_lease.py <lease.json>`. Stop if it fails.
2. Read [references/lease-contract.md](references/lease-contract.md) when a field or strategy is ambiguous.
3. Load only the leased parents, inspirations, and bounded context. Official verified results are evidence; observations and screening scores are not fitness.
4. Execute the strategy:
   - `seed`: build an independent baseline from the task contract.
   - `explore`: pursue an orthogonal mechanism. When `control.explore` is true, prefer a stepwise redesign or full implementation over a cosmetic diff.
   - `exploit`: retain the parent premise and make the smallest evidence-backed improvement.
   - `migrate`: adapt the inspiration's useful mechanism to the target parent; do not copy its artifact unchanged.
   - `fuse`: reconcile the two parents into one coherent implementation and resolve incompatibilities explicitly.
   - `diverge`: perform meta-analysis of the verified trajectory, state a qualitatively different tactic, then implement it. Parameter-only retuning does not satisfy divergence.
5. Honor the variation mandate's operator. If strategy and operator appear in tension, satisfy both through the narrowest coherent interpretation; do not edit either assignment.
6. Run task-permitted local checks. Debug and revise within the lease, but return exactly one new artifact for external evaluation.
7. Report the implemented hypothesis, changed mechanism, local evidence, artifact URI/hash, and unresolved risks. Do not claim a benchmark improvement before the evaluator verifies it.

## Integrity rules

- Never inspect hidden tests, release answers, evaluator internals, or benchmark leaderboards to choose the change.
- Never feed intervention outcomes, self-reported scores, or non-final fidelity results into routing.
- Treat intensity and reward fields as controller diagnostics, not permission to change compute budgets.
- Preserve reproducibility: pin dependencies, record commands, and keep the returned artifact content-distinct from every context artifact.
- Reject stale or malformed leases instead of guessing a route.
