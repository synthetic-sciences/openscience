---
name: coq
description: Develops and checks proofs in Coq and its renamed successor Rocq, covering the `_CoqProject` and `coq_makefile` (or `rocq makefile`) build, `coqc` and `coqchk` (or `rocq compile` and `rocq check`), finding lemmas with `Search` and `SearchPattern`, choosing `Qed` versus `Defined` and `Opaque` versus `Transparent`, finishing without `Admitted`, auditing with `Print Assumptions`, and stating the exact proposition the informal claim makes. Use when asked to prove, formalize, check or repair a Coq or Rocq development; use lean4-mathlib for Lean, and ordinary mathematical writing for informal proofs.
summary: "Coq and Rocq workflow; _CoqProject, Search, Qed vs Defined, no Admitted, assumptions."
category: other
allowed-tools: [Read, Write, Edit, Bash]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Coq and Rocq

`Admitted` compiles, and so does a theorem about the wrong proposition. The kernel checks
the proof; you check that the statement is the claim, that no assumption was smuggled in,
and that the compiled library passes an independent check. Coq 8.x commands and the Rocq 9
`rocq` subcommands are both given; use the pair the installed version provides.

## Project

1. `_CoqProject` lists the logical mapping and the files: `-Q theories MyLib` (or `-R`
   for recursive legacy mapping), optional `-arg -w -arg -notation-overridden`, then one
   `.v` path per line. Generate the Makefile with `coq_makefile -f _CoqProject -o Makefile`
   (Rocq 9: `rocq makefile -f _CoqProject -o Makefile`) and build with `make`. A single
   file compiles with `coqc -Q theories MyLib theories/File.v` (`rocq compile`). Dune
   projects use a `(coq.theory (name MyLib))` stanza instead.
2. Install and pin through opam (`opam install coq.8.20.0` or `rocq-prover`), and record
   the version with `coqc --version` (`rocq --version`). Library packages such as
   `coq-mathcomp-ssreflect` or `coq-stdpp` change tactic vocabulary; note which are used.
3. Interactive checking: VsCoq or coq-lsp in the editor, `coqtop` (`rocq repl`) for quick
   experiments. Never trust a proof that was only stepped through interactively; compile
   the file.

## Statement fidelity

4. Run `Check`, `About`, `Print` and `Locate` on every notation and definition the
   statement uses. Traps: `nat` subtraction truncates, `/` and `mod` on `nat` and `Z`
   follow different rounding conventions, `Prop` versus `bool` (`=` versus `=?`, bridged by
   `reflect`), implicit coercions (`Print Coercions`, `Set Printing Coercions`), notations
   that hide arguments (`Set Printing All`). Real numbers in the standard library are
   axiomatized, so `Print Assumptions` on a real-analysis result lists their axioms.
5. Evaluate the statement on a concrete instance: `Compute`, `Eval compute in`, or an
   `Example` closed by `reflexivity`. Use `Fail` to assert that a wrong variant does not
   typecheck. Check hypotheses are satisfiable with a concrete witness.
6. Hypotheses belong in the theorem statement. `Axiom` and `Parameter` become genuine
   assumptions of everything downstream; section `Variable`s are discharged into premises
   when the section closes. State the claim as one closed theorem so a reader sees every
   premise.

## Search

7. `Search (_ + _ = _ + _).`, `Search "comm" in Nat.`, `Search plus minus.`,
   `SearchPattern (_ <= _ + _).`, `SearchRewrite (_ + 0).`; filters `inside` and
   `outside` restrict modules. `Locate "+"` resolves a notation to its definition. Load
   `Lia` for `lia` (linear integer arithmetic), `Lra` for `lra`, `Ring`, `Field`, `Nia`.
8. Tactic families: `lia`, `nia`, `lra`, `ring`, `field`, `congruence`, `auto` and
   `eauto` with hint databases, `firstorder`, `intuition`; ssreflect if MathComp is in
   use. Name introduced variables (`intros x y H`) rather than relying on generated names.

## Hygiene

9. `Qed` seals a proof as opaque, right for theorems. `Defined` keeps it transparent, needed
   only when other code must compute through it (definitions built by tactics, `Program`,
   dependent types). `Opaque` and `Transparent` adjust later; `Print Opaque Dependencies`
   and `Print Transparent Dependencies` show the consequences. A transparent lemma inside
   a computation can make `simpl` explode.
10. No `Admitted` and no `admit` in a finished development. Use bullets (`-`, `+`, `*`) or
    `{ }` for subgoals and `Set Default Goal Selector "!".` so a tactic that accidentally
    applies to several goals fails loudly.
11. Run the independent checker on the compiled library, `coqchk -Q theories MyLib`
    followed by the module name (`rocq check` in Rocq 9), with `-o` to print the
    assumptions it found. It re-verifies the `.vo` files without trusting the compiler's
    bookkeeping.

## Audit

12. `Print Assumptions my_theorem.` The answer `Closed under the global context` means no
    axioms and no admitted lemmas. Otherwise it lists each axiom (for example
    `functional_extensionality_dep`, `Classical_Prop.classic`, `proof_irrelevance`,
    `Eqdep.Eq_rect_eq.eq_rect_eq`, the real-number axioms) and every `Admitted` result the
    proof depends on. Quote the list verbatim and say which items are standard classical
    or extensionality axioms and which are unfinished proofs.
13. Deliver the sources, the `_CoqProject`, the exact build and `coqchk` commands with their
    output, the `Print Assumptions` output, and a clause-by-clause mapping from the
    informal claim to the formal statement.

## Checklist

- [ ] `_CoqProject` and Makefile build cleanly from scratch; version recorded.
- [ ] Every definition and notation in the statement inspected with `Print` or `Locate`.
- [ ] Statement evaluated on a concrete instance; hypotheses shown satisfiable.
- [ ] No `Admitted`, `admit`, stray `Axiom` or `Parameter`.
- [ ] `Print Assumptions` and `coqchk` output recorded and explained.

## Sources

- Rocq reference manual (commands, `Search`, `Print Assumptions`, `rocq makefile`): https://rocq-prover.org/doc/V9.0.0/refman/
- Coq 8.20 reference manual: https://coq.inria.fr/doc/V8.20.0/refman/
- Rocq standard library: https://rocq-prover.org/doc/V9.0.0/stdlib/
- Rocq Platform and opam packages: https://github.com/rocq-prover/platform
- Software Foundations, Volume 1 (Logical Foundations): https://softwarefoundations.cis.upenn.edu/lf-current/
- Certified Programming with Dependent Types: http://adam.chlipala.net/cpdt/
- coq-lsp: https://github.com/ejgallego/coq-lsp
