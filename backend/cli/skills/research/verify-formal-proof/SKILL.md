---
name: verify-formal-proof
description: Freeze and preflight evaluator-owned Lean 4 proof verification evidence, including the trusted challenge, exact proof artifact, toolchain and dependency closure, forbidden-source audit, transitive axiom inventory, fresh kernel replay, and optional sandboxed independent checker. Use when a benchmark or research claim must distinguish an exact proof, exact refutation, or repaired-statement proof and obtain a formal-proof-v1 receipt.
---

# Verify a formal proof

Run every checker in an evaluator-controlled sandbox outside the candidate's
workspace. This skill commits real files and transcripts; it does not turn a
model assertion or a successful editor checkmark into proof evidence.

Read [references/protocol.md](references/protocol.md) before choosing a trust
tier or claim relation.

## Freeze the challenge

1. Put the trusted challenge and canonical elaborated statement in separate
   files. Pin the fully-qualified declaration and module.
2. Pin `lean-toolchain`, `lake-manifest.json`, a complete dependency-tree
   export, and every checker executable. Use a content-addressed sandbox image
   for `external_crosscheck`.
3. Choose `exact_proof`, `exact_refutation`, or `repaired_proof`. A repaired
   theorem is never interchangeable with the original challenge.
4. Run `bun scripts/preflight.ts protocol protocol-manifest.json` and bind the
   emitted `protocol` before proof search begins.

## Verify and submit

1. In the frozen environment, build the target module with warnings treated as
   failures and retain the complete transcript.
2. Run the frozen source auditor over every manifest file and retain its
   transcript. It must reject `sorry`, `admit`, `debug.skipKernelTC`, and
   `native_decide`; then audit the declaration's transitive axioms, traversing
   axiom types as well as proof bodies and rejecting `sorryAx` plus every axiom
   outside the frozen allowlist.
3. For `fresh_recheck`, run `lean4checker --fresh`. For
   `external_crosscheck`, use a sandboxed comparator to match the trusted
   challenge, export the proof term, and obtain acceptance from both the Lean
   kernel and the independently implemented checker.
4. Prepare the private evidence manifest and run
   `bun scripts/preflight.ts submission preflight.json evidence.json`.
5. Inject the evaluator token only at the authenticated boundary, submit
   `output.submission` to `POST /harness/proofs/receipts`, and cite the returned
   `receiptID` as `proofReceiptID` in the final evaluation.

The script hashes every manifest file and verifier transcript. It emits no
proof source, hidden challenge text, raw transcript, executable path, or bearer
capability.

## Do not overclaim

Kernel acceptance establishes the frozen formal statement relative to its
reported axioms and environment. It does not establish that the statement or
custom definitions faithfully express the intended informal mathematics.
Preserve separate semantic review for autoformalization, repaired statements,
and research-level novelty claims.
