---
name: operate-proof-blueprint
description: Operate evaluator-owned, verifier-grounded Lean proof search as a bounded content-addressed AND/OR blueprint. Use when a formal-proof-v1 benchmark should try direct proofs, compile decomposition sketches, share repeated lemmas, lease parallel subgoals, retain failed attempts, or refine blocked branches without treating search progress as final proof evidence.
---

# Operate a proof blueprint

Keep the evaluator in control of leases, compiler execution, reviewer evidence,
and submissions. The proving agent may propose source and decompositions but
must never possess the evaluator token or report its own verifier success.

Read [references/protocol.md](references/protocol.md) before configuring limits
or interpreting graph status.

## Freeze the search protocol

1. Pin the graph schema, the same Lean kernel used by `formal-proof-v1`, a
   sketch validator, reviewer executable, and reviewer rubric. Treat the
   reviewer only as a search heuristic.
2. Set hard node, depth, parallelism, direct-attempt, refinement, and lease
   limits before search.
3. Run `bun scripts/preflight.ts protocol blueprint-manifest.json` and put the
   emitted `blueprint` inside the formal-proof contract.
4. Have the evaluator call `POST /harness/proofs/blueprints` once. Repeating
   initialization is idempotent only for the same contract.

## Advance the frontier

1. Have the evaluator request work from `POST /harness/proofs/blueprints/leases`.
   Never fabricate, reuse, or transfer a lease.
2. Try a direct proof or refutation first. Run the frozen compiler against the
   exact leased declaration and retain its transcript and failure feedback.
3. After direct failure, propose a decomposition. Compile a sketch proving the
   parent while leaving placeholders only for the newly introduced child
   declarations. Run the frozen reviewer for relevance, lower difficulty, and
   plausibility.
4. Run `bun scripts/preflight.ts attempt preflight.json lease.json evidence.json`.
   Inject the evaluator token only at the authenticated boundary and submit the
   emitted payload to `POST /harness/proofs/blueprints/attempts`.
5. Continue with newly leased deepest-ready goals. When a branch blocks, add a
   new alternative; never rewrite a proved goal, delete a rejected attempt, or
   silently change a lemma signature.

The script hashes private source, binaries, feedback, and transcripts and emits
only content identifiers. It derives placeholder declarations from child specs
and emits no bearer capability.

## Finish with proof verification

Blueprint `proved` means the search graph has a compiler-grounded route. It is
not a proof receipt. Build the exact root artifact and use
`$verify-formal-proof`; only a passing `formal-proof-v1` receipt may appear as
`proofReceiptID` in a passing final evaluation.
