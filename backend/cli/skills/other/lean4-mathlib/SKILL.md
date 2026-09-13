---
name: lean4-mathlib
description: Formalizes and checks mathematical statements in Lean 4 with Mathlib, covering the lake project layout and pinned toolchain, `lake exe cache get` before `lake build`, searching Mathlib through Loogle, `exact?`, `apply?` and `simp?`, tactic hygiene, finishing without `sorry`, auditing with `#print axioms`, and making sure the formal theorem statement matches the informal claim exactly. Use when asked to prove, formalize, check or repair a Lean theorem or a Mathlib-based development; use the coq skill for Coq or Rocq, and ordinary mathematical writing for informal proofs.
summary: "Lean 4 and Mathlib workflow; lake, search, tactic hygiene, no sorry, axiom audit."
category: other
allowed-tools: [Read, Write, Edit, Bash, webfetch]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Lean 4 and Mathlib

A Lean proof is only as good as its statement. `sorry` compiles; a theorem about the wrong
object compiles; a theorem with an unsatisfiable hypothesis compiles. The work is statement
fidelity first, search before proving, build, then audit the axioms.

## Project layout

1. A Mathlib-dependent project has `lakefile.lean` or `lakefile.toml` (with
   `require mathlib from git "https://github.com/leanprover-community/mathlib4"`),
   `lean-toolchain` (the exact Lean version; it must match Mathlib's own `lean-toolchain`
   or the cache will not apply), and `lake-manifest.json` (locked dependency revisions).
   `lake new <name> math` scaffolds this. Do not run `lake update` casually: it moves the
   Mathlib revision and forces a full rebuild.
2. `lake exe cache get` downloads prebuilt Mathlib `.olean` files; without it `lake build`
   compiles Mathlib for hours. Then `lake build` builds the project, `lake build My.Module`
   one module, and `lake env lean path/File.lean` checks a single file with the project's
   search path. Read the build output to the end: warnings about `sorry` appear there.
3. `import Mathlib` is fine for exploration in a single file (slow to load); trim to the
   needed modules once the proof is stable.

## Statement fidelity

4. Write the informal claim as a docstring above the theorem, then translate each
   quantifier, hypothesis and domain deliberately. Traps: subtraction on `ℕ` truncates
   (`2 - 3 = 0`), `/` on `ℕ` and `ℤ` rounds, `x / 0 = 0` in fields, `Finset.range n` is
   `{0, ..., n - 1}`, `Nat.Prime` versus `Prime`, strict versus non-strict inequalities,
   "for all sufficiently large n" is `∃ N, ∀ n ≥ N, ...`. `#check` the statement,
   `#print` every borrowed definition, and confirm the meaning on a concrete instance
   with `example` plus `decide` or `norm_num`.
5. Test the hypotheses for satisfiability: from `h : 0 < 0` anything follows, and a
   theorem quantified over an empty type is vacuous. Provide one witness that satisfies
   all hypotheses as an `example`.
6. Put `set_option autoImplicit false` at the top of the file (or in the lakefile's
   `leanOptions`) so a misspelled identifier cannot silently become a new universally
   quantified variable.

## Search before proving

7. Loogle (https://loogle.lean-lang.org) searches by type pattern or constant name
   (`List ?a → ?a`, `Real.sqrt, _ * _`); Mathlib ships the `#loogle` and `#leansearch`
   commands from LeanSearchClient for the same queries inside the editor. The Mathlib
   docs (https://leanprover-community.github.io/mathlib4_docs) and the naming convention
   (`add_comm`, `mul_le_mul_left`, `Nat.succ_le_iff`) find the rest.
8. Inside a goal: `exact?` closes it with one library lemma when possible, `apply?` lists
   candidates, `rw?` suggests rewrites, `simp?` shows which simp lemmas fired so you can
   replace `simp` with `simp only [...]`, `hint` tries several finishers. Domain closers:
   `omega` (linear arithmetic on `ℕ` and `ℤ`), `linarith`, `nlinarith`, `positivity`,
   `norm_num`, `ring`, `field_simp`, `gcongr`, `decide`, `aesop`.

## Tactic hygiene

9. Replace mid-proof `simp` with the `simp only [...]` that `simp?` reports; a bare
   non-terminal `simp` breaks when Mathlib changes. Name hypotheses (`intro n hn`,
   `obtain ⟨x, hx⟩ := h`), avoid chains of `this`, and structure with `have`, `calc` and
   `refine ⟨?_, ?_⟩`. Paste the term `exact?` produced and delete the search call.
10. Keep a `by` block under a screen; split into lemmas with the informal statement as a
    docstring on each. No `sorry` in a finished file: the build prints
    `declaration uses 'sorry'` for every one. Avoid `native_decide` unless the user
    accepts trusting the compiler; it adds the `Lean.ofReduceBool` axiom.

## Audit

11. `#print axioms theoremName` after every finished proof. The expected set is
    `propext`, `Classical.choice`, `Quot.sound`. `sorryAx` means an unfinished proof
    somewhere in the dependency chain; `Lean.ofReduceBool` means `native_decide` was
    used. Quote the output verbatim in the report.
12. Deliver the file, the exact `lake build` command with its clean output, the
    `#print axioms` line, and a line-by-line mapping from the informal claim to the formal
    hypotheses and conclusion, naming every translation choice.

## Checklist

- [ ] `lean-toolchain` matches Mathlib; `lake exe cache get` then `lake build` succeed.
- [ ] Informal claim quoted above the theorem; each clause mapped to a hypothesis.
- [ ] Hypotheses shown satisfiable by an `example`.
- [ ] Searched before proving; `exact?` and `simp?` output pasted, not left in place.
- [ ] No `sorry`, no unexplained `native_decide`.
- [ ] `#print axioms` output recorded.

## Sources

- Lean 4 documentation: https://lean-lang.org/documentation/
- Lake (build system) README: https://github.com/leanprover/lean4/tree/master/src/lake
- Mathlib, using Mathlib in a project: https://leanprover-community.github.io/install/project.html
- Mathlib tactic reference: https://leanprover-community.github.io/mathlib4_docs/tactics.html
- Loogle: https://loogle.lean-lang.org
- LeanSearchClient (`#loogle`, `#leansearch`): https://github.com/leanprover-community/LeanSearchClient
- Theorem Proving in Lean 4: https://lean-lang.org/theorem_proving_in_lean4/
- Mathematics in Lean: https://leanprover-community.github.io/mathematics_in_lean/
