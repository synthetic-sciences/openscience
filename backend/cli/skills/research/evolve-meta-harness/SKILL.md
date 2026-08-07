---
name: evolve-meta-harness
description: Evolve an OpenScience prompt, memory, skill, tool, middleware, subagent, or scaffold as a versioned, trace-grounded harness and qualify it on frozen search plus unseen model/task cells before sealed promotion. Use when meta-harness-v1 is bound, when refining agent instructions from execution failures, or when activation, adherence, phase drift, context cost, cross-model transfer, rollback, and full candidate-history evidence must be audited.
---

# Evolve Meta Harness

Run this skill across two isolated roles: an updater may inspect only frozen search evidence and propose session-local deltas; the qualifier owns unseen models/tasks, adherence labels, and the one-shot receipt. Never let either role edit the benchmark evaluator, hidden inputs, qualification validator, protected roots, or baseline.

## Workflow

1. Freeze `meta-harness-v1` before search. Commit the immutable baseline artifact and manifests; exact mutable component roots; protected roots; archive and trace schemas; updater and judge identities; sorted search/held-out model-task matrices; and numeric promotion thresholds.
2. Preserve the baseline. Save each accepted delta as a new content-addressed snapshot with its parent hash. Use atomic writes and explicit rollback revisions. Local/session scope is the default; global promotion requires independent qualification.
3. Retain every search candidate, including failures and unevaluated proposals. Store full source, scores, and raw traces in the filesystem archive. A summary, reflection, or compressed memory is not a substitute for trace bytes.
4. For every refinement, cite an archived trace message, diagnose implementation versus fundamental failure, state the root cause, enumerate exact file/component changes, predict search-task flips or protected passing cells, and state the expected outcome before evaluation.
5. Terminate search before qualification. Request `POST /harness/meta/selection` with the qualifier capability. Do not accept a caller-selected candidate.
6. Run the exact baseline and selected candidate across every frozen model-task pair. Keep held-out models/tasks inaccessible to the updater. On activation-required candidate cells, record whether the harness loaded plus judge counts at `loaded`, `midpoint`, `pre_final`, and `final_validation`.
7. Build a token-free body with `scripts/build_submission.ts`. Inject `metaToken` only into the authenticated request in memory, then call `POST /harness/meta/receipts` once.
8. Proceed to sealed confirmation only when the backend-derived receipt is `passed`. Treat diagnostic gains, activation, adherence, drift, prediction precision, and loaded benefit as qualification evidence—not the official benchmark score.

## Build

```bash
bun skills/research/evolve-meta-harness/scripts/build_submission.ts \
  --protocol meta-protocol.json \
  --selection meta-selection.json \
  --archive archive-input.json \
  --refinements refinements.json \
  --cells qualification-cells.json \
  --candidate-manifest <sha256> \
  --output meta-submission.json
```

`archive-input.json` contains `{ "uri": "...", "entries": [...] }`. The builder fixes the archive policy from the protocol, hashes the sorted index and complete archive, validates the final body with the same runtime schema, and intentionally omits the capability token.

Read [references/qualification-contract.md](references/qualification-contract.md) before constructing cells or refinements. Read [references/source-mechanisms.md](references/source-mechanisms.md) when changing the architecture or claiming provenance from upstream systems.

## Fail Closed

- Do not adapt on held-out model/task outcomes, even indirectly through memory, reflection, or branch selection.
- Do not overwrite snapshots or repair a frozen receipt. A failed or inconclusive first qualification remains canonical.
- Reject missing candidates, summary-only traces, stale parents, duplicate predictions, unsorted matrices, fabricated source hashes, and mutable/protected root overlap.
- Count a required action as followed only when trace evidence supports it. Use `requiredUnobserved` or `insufficientEvidence` instead of optimistic inference.
- Require complete paired cells for every baseline/candidate cross product. Missing scores remain inconclusive; they are never zero or passing.
- Report the model-harness pair. Never attribute a harness gain to the model alone.
