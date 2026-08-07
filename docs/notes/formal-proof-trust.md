# Formal proof trust receipts

Date: 2026-08-05

## Decision

Add an opt-in `formal-proof-v1` contract and evaluator-authenticated receipt
for Lean 4 results. Bind theorem identity, proof relation, exact artifact,
complete source and environment manifests, verifier identities, source policy,
transitive axiom policy, and the chosen trust tier before proof search. Never
promote an exact refutation or repaired statement as a proof of the original
challenge.

The tiers are `kernel`, `fresh_recheck`, and `external_crosscheck`. Strict
public benchmark and research claims should use the last tier. A passing final
evaluation must cite the sole canonical passing receipt for the exact run or
candidate bytes.

## Research basis

DeepMind's [LEAP](https://arxiv.org/abs/2606.03303) couples decomposition and
blueprints with compiler feedback and reports 70% on Lean-IMO-Bench plus 12/12
on the 2025 Putnam problems. [AlphaProof
Nexus](https://arxiv.org/abs/2605.22763) combines parallel Lean agents with
evolutionary coordination for open mathematical research. The open
[Goedel-Architect](https://arxiv.org/abs/2606.06468) makes lemma dependencies
explicit and uses failed proof obligations to refine the blueprint. These
systems motivate stronger search, but their search traces are not substitutes
for result-side verification.

Lean's official [proof-validation
guide](https://lean-lang.org/doc/reference/latest/ValidatingProofs/) describes
an escalating ladder from ordinary builds through axiom inspection and fresh
rechecking to a sandboxed gold-standard comparison with an external checker.
Lean [issue #8840](https://github.com/leanprover/lean4/issues/8840) shows why a
plain `#print axioms` result is insufficient in a hostile setting: dependencies
can occur in axiom types. The protocol therefore requires transitive traversal
of both proof bodies and axiom types.

The [Formal Conjectures](https://github.com/google-deepmind/formal-conjectures)
project uses immutable benchmark snapshots tied to a Lean version. The
kernel-checked [Erdős problem exclusion
result](https://arxiv.org/abs/2607.25628) demonstrates the value of a CI gate
that excludes `sorry`, unchecked native decisions, and solver additions to the
trusted base. The protocol freezes a source auditor and rejects `sorry`,
`admit`, `debug.skipKernelTC`, and `native_decide`, while separately enforcing
the axiom closure.

[MechGeo](https://arxiv.org/abs/2608.02295) formally refutes two geometry
statements in Lean-IMO-Bench and proves corrected replacements. That result is
the reason claim relation is part of receipt identity: repaired formalization
is valuable evidence, but it is not an exact benchmark solve.

## Backend derivation

The evaluator supplies hashes and transcripts, never raw hidden challenges or
capabilities. OpenScience recomputes and binds:

- exact challenge, statement, declaration, module, relation, and artifact;
- one canonically ordered complete manifest containing challenge, statement,
  proof, toolchain, Lake manifest, and dependency closure;
- distinct frozen verifier artifacts required by the selected tier;
- a complete source audit with no forbidden construct findings;
- a complete, canonically ordered transitive axiom inventory whose types were
  traversed and whose entries all appear in the frozen allowlist;
- warning-free kernel acceptance, optional fresh replay, and optional exact
  sandboxed comparison accepted by Lean plus an external checker; and
- subject creation and verification timestamps that prevent a post-hoc or
  cross-candidate receipt.

The receipt is content-addressed without its recording timestamp. A subject
can freeze only one receipt, including a failed one, so unfavorable verification
cannot be replaced by a later retry.

## Attacks covered

- Swap in an easier statement or silently prove a repaired theorem.
- Attach a valid proof from another task, run, candidate, or Lean environment.
- Omit support files or change dependency, toolchain, or verifier bytes.
- Pass a build containing `sorry`, `admit`, `debug.skipKernelTC`, or
  `native_decide`.
- Hide a custom axiom through a dependency in an axiom's type.
- Claim fresh or independent verification using the ordinary build process.
- Reuse a failed subject with a favorable second receipt.
- Record proof evidence after the final benchmark evaluation.

## Explicit limits

Artifact commitments prove identity inside the evaluator boundary; they do not
make an unqualified evaluator honest. The kernel and fresh tiers still depend
on Lean's implementation and the frozen audit wrappers. The external tier
reduces correlated implementation risk but does not remove it.

Most importantly, a kernel can validate a vacuous or mistranslated statement.
Formal acceptance establishes only the frozen Lean proposition relative to its
reported axioms and environment. Informal correspondence, definition quality,
novelty, significance, benchmark comparability, and SOTA all need separate
semantic and empirical evidence.
