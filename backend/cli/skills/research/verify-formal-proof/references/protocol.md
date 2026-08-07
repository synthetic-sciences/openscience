# Formal proof trust protocol

OpenScience follows the escalating validation model in Lean's official
[Validating a Lean Proof](https://lean-lang.org/doc/reference/latest/ValidatingProofs/)
guide:

- `kernel`: the frozen module builds, the Lean kernel accepts the declaration,
  warnings are absent, a frozen source auditor rejects unchecked escape
  constructs, and the transitive axiom closure is within policy.
- `fresh_recheck`: all kernel checks plus `lean4checker --fresh` replay of the
  stored declarations and proof terms.
- `external_crosscheck`: all preceding checks plus a sandboxed comparator that
  matches the exact trusted challenge, exports the proof term, and obtains
  agreement from the Lean kernel and an independent external checker.

The axiom audit must traverse axiom types. A plain textual `#print axioms`
transcript alone is not enough for a hostile setting because Lean issue #8840
documents a class of dependencies hidden in axiom types. `sorryAx` is never
allowed. The source policy also rejects `sorry`, `admit`,
`debug.skipKernelTC`, and `native_decide`; this is distinct from and cannot
replace the transitive axiom audit. `Lean.trustCompiler`, `Lean.ofReduceBool`, `Lean.ofReduceNat`, custom
axioms, and the three standard axioms are accepted only when explicitly frozen
in `allowedAxioms`.

The relation is part of theorem identity:

- `exact_proof` proves the trusted challenge unchanged.
- `exact_refutation` proves the contract's frozen refutation statement or
  kernel-checked counterexample unchanged.
- `repaired_proof` proves a separately frozen repaired statement and must not
  count as solving the original benchmark item.

This distinction is motivated by [MechGeo](https://arxiv.org/abs/2608.02295),
which formally refuted two Lean-IMO-Bench geometry statements and proved their
expert-corrected repairs. Search architecture can follow
[LEAP](https://arxiv.org/abs/2606.03303) or [AlphaProof
Nexus](https://arxiv.org/abs/2605.22763), but no search trace replaces the
result-side verifier receipt.
