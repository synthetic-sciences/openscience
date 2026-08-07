# Human-AI autonomy receipts

Date: 2026-08-05

## Decision

Treat benchmark autonomy as a provenance result derived from a complete,
evaluator-owned interaction trace. Do not accept the existing caller-supplied
`autonomous` or `human_reprompted` field as evidence of who produced the
scientific content.

The opt-in `human-ai-autonomy-v1` protocol predeclares a claimed contribution
level, evaluator-runtime recorder artifact, trace schema, semantic
classification policy, raw-retention and disclosure policies, and event
ceiling. A passing final evaluation must cite the single canonical receipt for
the exact run or candidate artifact.

## Research basis

Google DeepMind's [Towards Autonomous Mathematics
Research](https://arxiv.org/abs/2602.10177) defines three contribution levels:
primarily human (core content human-generated), human-AI collaboration (both
contribute essentially), and essentially autonomous (core content AI-generated
without essential human intervention). It treats posing the question,
exposition, and genuinely minor corrections as compatible with essentially
autonomous work, acknowledges ambiguous cases, and proposes Human-AI
Interaction cards plus access to important raw prompts and outputs for
essential contributions.

The same paper warns that the evaluation gap encourages misleading autonomy
claims. DeepMind's [Conjecture Machines and the new validation bottleneck in
science](https://deepmind.google/public-policy/conjecture-machines-ai-agents-and-the-new-validation-bottleneck-in-science/)
argues that independent validation becomes the limiting resource as agents
generate more hypotheses. Together these motivate a capability-separated
recorder and a fail-closed promotion gate, not a self-authored model card.

## Backend derivation

Actors are `benchmark`, `human`, and `agent`. Events use one of ten observable
interaction kinds and one contribution class: `problem`, `auxiliary`,
`essential`, `core`, or `unclear`.

- Substantive agent content with no substantive human content derives
  `essentially_autonomous`.
- Substantive human and agent content derives `human_ai_collaboration`.
- Substantive human content with only auxiliary agent content derives
  `primarily_human`.
- Any unclear classification yields `inconclusive`.

The backend additionally requires a frozen problem statement, at least one
agent event, an exact contract-start timestamp, contiguous and monotonic events,
a real event-ID hash chain, a continuous artifact transition chain, and a last
transition equal to the evaluated artifact. Candidate traces must enclose the
server-recorded candidate creation time and match the candidate's registered
artifact SHA-256.

## Attacks covered

- Relabel an essential human strategy hint as an autonomous pass.
- Supply only the favorable suffix of a run after human guidance.
- Reorder, delete, or alter events after receipt creation.
- Attach a receipt from another run, candidate, or artifact.
- Link the expected artifact once and then apply an unreported final edit.
- Submit a future or post-hoc trace or evaluate before receipt creation.
- Replace a failed or inconclusive trace with a favorable retry.
- Let the candidate call receipt routes without the evaluator capability.

## Explicit limits

Cryptographic commitments prove byte identity and ordering inside the captured
boundary. They do not prove that the evaluator omitted no off-platform human
conversation, or that an `auxiliary` versus `essential` judgment is
semantically correct. Credible use therefore still requires an evaluator-owned
recorder, controlled communication boundary, retained raw prompts and outputs,
and qualified expert review. The receipt reports contribution provenance; it
does not establish scientific correctness, novelty, significance, or benchmark
SOTA.

`public_essential_after_release` can commit a run to disclose essential
interactions once hidden material may safely be released. Until then,
`evaluator_retained` keeps raw benchmark content private while preserving
auditable hashes and evidence references.
