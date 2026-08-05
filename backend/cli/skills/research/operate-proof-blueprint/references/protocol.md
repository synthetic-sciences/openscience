# Proof blueprint protocol

OpenScience models proof search as a monotone bipartite AND/OR DAG, following
the verifier-grounded decomposition pattern in
[LEAP](https://arxiv.org/abs/2606.03303). A goal is an OR node: a direct
compiler-accepted result or any closed decomposition may solve it. A
decomposition is an AND node: every child must be proved. The exact tuple
`(statementSHA256, declaration, module)` identifies a goal, so repeated lemmas
share work rather than spawning independent copies.

The server derives status and scheduling:

- The root exactly matches the frozen `formal-proof-v1` statement.
- A direct attempt precedes decomposition.
- An accepted sketch proves the parent assuming only the declared child goals;
  its placeholder list must equal those child declarations exactly.
- The graph must remain reachable, acyclic, and within frozen node/depth limits.
- An open accepted branch suspends its parent while deepest-ready children run.
- A blocked branch returns its parent to the frontier for a bounded alternative.
- Every verifier/reviewer rejection consumes its lease and remains in the
  contiguous attempt history.
- Stale, consumed, cross-session, and substituted-verifier leases fail closed.

This preserves the useful failure-driven refinement in
[Goedel-Architect](https://arxiv.org/abs/2606.06468) without allowing a failed
helper to be silently repaired in place. Independent compiler calls and
statement-safety separation follow
[AlphaProof Nexus](https://arxiv.org/abs/2605.22763). Representation may evolve
only through a new frozen protocol; verifier authority remains fixed, as in
[Self-Modifying Lean Proof Agents](https://arxiv.org/abs/2607.17352).

Endpoints are evaluator-capability protected:

| Method | Path | Effect |
|---|---|---|
| `POST` | `/harness/proofs/blueprints` | Initialize the exact root |
| `POST` | `/harness/proofs/blueprints/status` | Read derived graph state |
| `POST` | `/harness/proofs/blueprints/leases` | Atomically lease ready goals |
| `POST` | `/harness/proofs/blueprints/attempts` | Consume a lease and retain an outcome |

The reviewer cannot certify correctness. Blueprint closure cannot certify the
root. Final authority always remains `formal-proof-v1`, including its source,
axiom, fresh-recheck, and external-crosscheck policies.
