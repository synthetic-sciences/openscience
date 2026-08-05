# Verifier-grounded proof blueprints

## Design question

How can OpenScience borrow the strongest recent formal-proof search mechanisms
without letting a search controller, language-model reviewer, or successful
partial build impersonate final proof evidence?

## Primary-source findings

- [LEAP](https://arxiv.org/abs/2606.03303) turns a theorem into a bipartite
  AND/OR DAG. It tries a direct proof, compiles a sketch of the parent assuming
  only newly proposed lemmas, treats each decomposition as an AND node, treats
  each goal as an OR node, shares reusable lemmas, checks acyclicity, and uses
  reviewer judgments to reject bad decompositions before expanding them.
- [Goedel-Architect](https://arxiv.org/abs/2606.06468) preserves proved lemmas
  and refines around diagnosed failures. Its useful transferable mechanism is
  failure-local repair; OpenScience implements that as a new immutable
  alternative branch rather than rewriting or dropping an existing lemma.
- [AlphaProof Nexus](https://arxiv.org/abs/2605.22763) runs independent prover
  workers, invokes Lean after edits, and separates proof search from SafeVerify
  checks for statement or environment exploits. This motivates evaluator-owned
  bounded leases and a separate final verifier.
- [Self-Modifying Lean Proof Agents](https://arxiv.org/abs/2607.17352) allows
  the machine-readable proof context to evolve while keeping verifier
  grounding fixed. OpenScience therefore versions the graph representation but
  freezes all evaluator artifacts and final authority in the run contract.
- [OProver](https://arxiv.org/abs/2605.17283) emphasizes compiler-verified proof
  and repair trajectories at scale. This supports preserving negative
  compiler feedback as reusable search state rather than retaining only wins.

These systems improve search. None eliminates the need to freeze theorem
identity, audit unchecked constructs and transitive axioms, or replay the final
artifact under the selected trust tier.

## OpenScience protocol

The optional `proof-blueprint-v1` contract freezes five distinct content
artifacts: graph schema, Lean compiler, sketch validator, decomposition
reviewer, and reviewer rubric. The compiler is exactly the `lean_kernel`
artifact already bound by `formal-proof-v1`. It also freezes hard limits for
goals, graph depth, parallel leases, direct attempts per goal, refinements per
goal, and lease lifetime.

The backend initializes one root goal from the exact formal statement. A goal
identity hashes `(statementSHA256, declaration, module)`, which makes lemma
reuse explicit. A decomposition is admitted only after a direct attempt and
only when:

1. the frozen compiler checked the exact leased parent without warnings;
2. the frozen sketch validator found placeholders exactly equal to the new
   child declarations; and
3. the frozen reviewer marked the branch relevant, easier, and plausible.

Reviewer failure is retained but does not create graph nodes. Verifier failure
is retained. Accepted branches and proved goals are never mutated. A blocked
branch makes its parent eligible for another bounded alternative. Every write
atomically revalidates content identities, complete contiguous histories,
lease provenance, reachability, acyclicity, longest depth, node count, and per-
goal budgets.

## Authority boundary

Blueprint state is search provenance. `proved` means that direct accepted
attempts and closed AND nodes form a route to the root. It does not imply a
complete source audit, transitive axiom audit, fresh kernel replay, independent
checker agreement, or semantic correspondence to the informal problem.

Consequently:

- blueprint status is included in reports as execution metadata;
- it never supplies `proofReceiptID`;
- it cannot make a final evaluation pass; and
- the exact root artifact must still pass `formal-proof-v1`.

This boundary makes the architecture useful for proof search and safe to
ablate without overstating what has been formally established.
